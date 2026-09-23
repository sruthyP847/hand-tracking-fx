import type { Effect, HandLandmarks } from './types'

/**
 * "Particles" effect: fireworks-style sparks fly out of every fingertip.
 * Move fast and you throw a shower of them; hold still and you get a trickle.
 *
 * Performance notes (this runs every frame, so it matters):
 *  - No shadowBlur. Instead a soft glow is rendered ONCE into a small
 *    offscreen canvas ("sprite"), and each spark is just a drawImage of it.
 *  - Sparks change colour over their life. Rather than tint each one (slow)
 *    we pre-render a short ladder of sprites from white-hot to deep red and
 *    pick the nearest one for each spark's age.
 *  - 'lighter' compositing adds colours together, so overlapping sparks glow
 *    brighter for free.
 *  - Everything moves by elapsed time (dt), so the speed looks the same at
 *    30, 60 or 120 fps.
 */

// ---- Tunables ----------------------------------------------------------------

/**
 * Opacity (0..1) of the black layer painted over the video each frame.
 * Dimming the video makes the sparks stand out, especially against bright
 * backgrounds. 0 = no dimming, 1 = black screen.
 */
const DIM_OPACITY = 0.35

/** Hard ceiling on live sparks. Oldest ones are dropped when exceeded. */
const MAX_PARTICLES = 2000

/** Sparks per second from a fingertip that is not moving at all. */
const BASE_RATE = 10
/** Extra sparks per second per pixel-per-second of fingertip speed. */
const RATE_PER_SPEED = 0.12
/** Cap so a wild flick doesn't spawn thousands in one frame. */
const MAX_RATE = 800

/** How much of the finger's velocity a spark inherits (0..1). */
const INHERIT_VELOCITY = 0.35
/** Random extra speed in a random direction, in px/s (min..max). */
const SPREAD_MIN = 30
const SPREAD_MAX = 180

const LIFE_MIN = 0.6 // seconds
const LIFE_MAX = 1.2

const GRAVITY = 250 // px/s², downwards
const DRAG = 2.5 // higher = sparks slow down sooner

const SIZE_MIN = 12 // px, diameter at birth
const SIZE_MAX = 30

/** Landmark indices of the five fingertips. */
const FINGERTIPS = [4, 8, 12, 16, 20]

/**
 * Colour of a spark over its life, from birth (first entry) to death (last).
 * Values are [r, g, b]. Intermediate colours are blended.
 */
const LIFE_COLORS: [number, number, number][] = [
  [255, 255, 255], // white-hot
  [255, 215, 90], // gold
  [255, 130, 30], // orange
  [180, 30, 20], // deep red
]

/** How many pre-rendered sprites to make along that colour ramp. */
const SPRITE_STEPS = 16
/** Pixel size of each sprite canvas. Drawn scaled, so it can stay small. */
const SPRITE_SIZE = 64

/**
 * Shape of the glow sprite, as fractions of its radius:
 *  - inside CORE_RADIUS the colour is solid and fully opaque (the hot centre)
 *  - from there to the edge it fades out (the soft halo)
 */
const CORE_RADIUS = 0.2

// ---- State -------------------------------------------------------------------

interface Particle {
  x: number
  y: number
  vx: number // px/s
  vy: number
  born: number // time (ms) it was spawned
  life: number // ms it will live
  size: number // diameter at birth, px
}

/** Where a fingertip was last frame, so we can work out how fast it's moving. */
interface TipTracker {
  x: number
  y: number
  /** Fractional sparks carried over between frames, e.g. 0.4 + 0.4 = spawn 1. */
  emitDebt: number
}

let sparks: Particle[] = []
let tips = new Map<string, TipTracker>()
let sprites: HTMLCanvasElement[] = []
let lastTime = -1

// ---- The effect --------------------------------------------------------------

export const particles: Effect = {
  name: 'Particles',

  init() {
    if (sprites.length === 0) sprites = buildSprites()
    lastTime = -1
  },

  draw(ctx, hands, _video, time) {
    // Elapsed time since last frame, in seconds. Clamped so that a paused
    // tab coming back doesn't teleport every spark off-screen.
    const dt = lastTime < 0 ? 1 / 60 : Math.min((time - lastTime) / 1000, 0.05)
    lastTime = time

    dimVideo(ctx)
    emitFromFingertips(ctx, hands, time, dt)
    updateParticles(time, dt)
    drawParticles(ctx, time)
  },

  cleanup() {
    sparks = []
    tips = new Map()
    lastTime = -1
    // Sprites are cheap to keep and identical every time, so we leave them.
  },
}

// ---- Sprites: the one-time glow render ---------------------------------------

/**
 * Renders SPRITE_STEPS small canvases, each a soft radial glow in one colour
 * along the LIFE_COLORS ramp. Index 0 is white-hot, the last one deep red.
 */
function buildSprites(): HTMLCanvasElement[] {
  const result: HTMLCanvasElement[] = []
  for (let i = 0; i < SPRITE_STEPS; i++) {
    const [r, g, b] = sampleRamp(i / (SPRITE_STEPS - 1))

    const canvas = document.createElement('canvas')
    canvas.width = SPRITE_SIZE
    canvas.height = SPRITE_SIZE
    const c = canvas.getContext('2d')!

    // Solid bright core, then a wide soft halo out to the edge.
    const half = SPRITE_SIZE / 2
    const grad = c.createRadialGradient(half, half, 0, half, half, half)
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`)
    grad.addColorStop(CORE_RADIUS, `rgba(${r},${g},${b},1)`)
    grad.addColorStop(0.45, `rgba(${r},${g},${b},0.5)`)
    grad.addColorStop(0.75, `rgba(${r},${g},${b},0.15)`)
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
    c.fillStyle = grad
    c.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)

    result.push(canvas)
  }
  return result
}

/** Blend along LIFE_COLORS. t = 0 gives the first colour, t = 1 the last. */
function sampleRamp(t: number): [number, number, number] {
  const scaled = t * (LIFE_COLORS.length - 1)
  const i = Math.min(Math.floor(scaled), LIFE_COLORS.length - 2)
  const f = scaled - i
  const a = LIFE_COLORS[i]
  const b = LIFE_COLORS[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

// ---- Step 1: spawn sparks at the fingertips ----------------------------------

function emitFromFingertips(
  ctx: CanvasRenderingContext2D,
  hands: HandLandmarks[],
  time: number,
  dt: number,
) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  const seen = new Set<string>()

  hands.forEach((hand, handIndex) => {
    for (const tip of FINGERTIPS) {
      const key = `${handIndex}-${tip}`
      seen.add(key)
      const x = hand[tip].x * w
      const y = hand[tip].y * h

      const prev = tips.get(key)
      if (!prev) {
        // First time we see this fingertip: we can't know its speed yet.
        tips.set(key, { x, y, emitDebt: 0 })
        continue
      }

      // Velocity in px/s from how far it moved since last frame.
      const vx = (x - prev.x) / dt
      const vy = (y - prev.y) / dt
      const speed = Math.hypot(vx, vy)

      // Faster = more sparks. Keep the fractional remainder for next frame so
      // low rates still produce the occasional spark instead of none.
      const rate = Math.min(MAX_RATE, BASE_RATE + speed * RATE_PER_SPEED)
      prev.emitDebt += rate * dt
      const count = Math.floor(prev.emitDebt)
      prev.emitDebt -= count

      for (let i = 0; i < count; i++) {
        // Spread the spawn points along the path the finger just travelled,
        // otherwise a fast flick leaves visible clumps once per frame.
        const along = Math.random()
        spawn(prev.x + (x - prev.x) * along, prev.y + (y - prev.y) * along, vx, vy, time)
      }

      prev.x = x
      prev.y = y
    }
  })

  // Forget fingertips that weren't in this frame. When they reappear they
  // start fresh, so a hand re-entering doesn't get a bogus huge velocity.
  for (const key of tips.keys()) {
    if (!seen.has(key)) tips.delete(key)
  }
}

function spawn(x: number, y: number, fingerVx: number, fingerVy: number, time: number) {
  const angle = Math.random() * Math.PI * 2
  const spread = SPREAD_MIN + Math.random() * (SPREAD_MAX - SPREAD_MIN)

  sparks.push({
    x,
    y,
    vx: fingerVx * INHERIT_VELOCITY + Math.cos(angle) * spread,
    vy: fingerVy * INHERIT_VELOCITY + Math.sin(angle) * spread,
    born: time,
    life: (LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN)) * 1000,
    size: SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN),
  })

  // Over the cap? Drop the oldest. They're at the front of the array.
  if (sparks.length > MAX_PARTICLES) {
    sparks.splice(0, sparks.length - MAX_PARTICLES)
  }
}

// ---- Step 2: physics -----------------------------------------------------------

function updateParticles(time: number, dt: number) {
  // Drag as an exponential decay: v *= e^(-DRAG*dt). Frame-rate independent.
  const dragFactor = Math.exp(-DRAG * dt)

  // Filter out dead sparks and move the live ones in a single pass.
  sparks = sparks.filter((p) => {
    if (time - p.born >= p.life) return false
    p.vy += GRAVITY * dt
    p.vx *= dragFactor
    p.vy *= dragFactor
    p.x += p.vx * dt
    p.y += p.vy * dt
    return true
  })
}

// ---- Step 3: draw ---------------------------------------------------------------

/**
 * Paints a translucent black rectangle over the whole canvas. The canvas sits
 * on top of the <video>, so this darkens the camera picture underneath and
 * gives the sparks a darker background to glow against. It has to be drawn
 * with normal (source-over) compositing, before switching to 'lighter'.
 */
function dimVideo(ctx: CanvasRenderingContext2D) {
  if (DIM_OPACITY <= 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = DIM_OPACITY
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.restore()
}

function drawParticles(ctx: CanvasRenderingContext2D, time: number) {
  if (sprites.length === 0) sprites = buildSprites() // safety if init was skipped

  ctx.save()
  // Additive blending: where sparks overlap, their colours add up and glow.
  ctx.globalCompositeOperation = 'lighter'

  for (const p of sparks) {
    // 0 = just born, 1 = about to die.
    const age = (time - p.born) / p.life

    // Pick the sprite for this age (white-hot -> red) and shrink + fade it.
    const sprite = sprites[Math.min(SPRITE_STEPS - 1, Math.floor(age * SPRITE_STEPS))]
    const size = p.size * (1 - age * 0.8) // shrink to 20% of birth size
    ctx.globalAlpha = 1 - age * age // hold bright, then fade out quickly

    ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size)
  }

  ctx.restore()
}
