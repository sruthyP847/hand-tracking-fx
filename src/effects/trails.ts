import type { Effect, HandLandmarks } from './types'

/**
 * "Trails" effect: every fingertip leaves a glowing neon trail that fades
 * out over about a second.
 *
 * How it works, in one paragraph: each frame we record where every fingertip
 * is (in canvas pixels) together with the current time. We keep about one
 * second of those points per fingertip. Because the canvas is wiped every
 * frame, we then redraw all the stored points as smooth curves, making the
 * older parts thinner and more transparent so they look like they're fading.
 */

// ---- Tunables ----------------------------------------------------------------

/** How long a point stays visible, in milliseconds. */
const FADE_MS = 1000

/**
 * If a fingertip has not been seen for longer than this, its next point starts
 * a fresh stroke instead of connecting to the old one. Without this, a hand
 * that leaves the frame and comes back elsewhere would draw a long straight
 * line across the screen.
 */
const MAX_GAP_MS = 150

/** Ignore movements smaller than this (pixels) to avoid piling up points. */
const MIN_MOVE_PX = 2

/** Line width when a point is brand new; it shrinks to ~0 as it ages. */
const MAX_WIDTH = 10

/** How far the neon glow spreads. Bigger looks softer but costs more GPU. */
const GLOW_BLUR = 14

/** Landmark indices of the five fingertips: thumb, index, middle, ring, pinky. */
const FINGERTIPS = [4, 8, 12, 16, 20]

/** One colour per fingertip, in the same order as FINGERTIPS (a rainbow). */
const COLORS = ['#ff3b3b', '#ffb020', '#3bff6e', '#3ba7ff', '#c05bff']

// ---- State -------------------------------------------------------------------

interface TrailPoint {
  x: number
  y: number
  /** performance.now() value when the point was recorded. */
  t: number
}

/**
 * Trail history, keyed by "<handIndex>-<fingertipIndex>" (e.g. "0-8" for the
 * index finger of the first detected hand). MediaPipe may occasionally swap
 * which hand is index 0 and 1, which just makes two trails swap colours
 * briefly; not worth the complexity of fixing here.
 */
const history = new Map<string, TrailPoint[]>()

// ---- The effect --------------------------------------------------------------

export const trails: Effect = {
  name: 'Trails',

  draw(ctx, hands, _video, time) {
    recordPoints(ctx, hands, time)
    pruneOldPoints(time)
    drawTrails(ctx, time)
  },

  cleanup() {
    history.clear()
  },
}

// ---- Step 1: record where the fingertips are ---------------------------------

function recordPoints(ctx: CanvasRenderingContext2D, hands: HandLandmarks[], time: number) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height

  hands.forEach((hand, handIndex) => {
    for (const tip of FINGERTIPS) {
      const key = `${handIndex}-${tip}`
      const x = hand[tip].x * w
      const y = hand[tip].y * h

      let points = history.get(key)
      if (!points) {
        points = []
        history.set(key, points)
      }

      // Skip if the finger barely moved; a trail made of near-identical
      // points just wastes drawing time.
      const last = points[points.length - 1]
      if (last && Math.hypot(x - last.x, y - last.y) < MIN_MOVE_PX) continue

      points.push({ x, y, t: time })
    }
  })
}

// ---- Step 2: forget points that are too old ----------------------------------

function pruneOldPoints(time: number) {
  for (const [key, points] of history) {
    // Points are appended in time order, so the old ones are at the front.
    let firstAlive = 0
    while (firstAlive < points.length && time - points[firstAlive].t > FADE_MS) {
      firstAlive++
    }
    if (firstAlive > 0) points.splice(0, firstAlive)

    // A fingertip whose hand left the frame keeps its trail until every point
    // has faded. Only then do we drop the entry entirely.
    if (points.length === 0) history.delete(key)
  }
}

// ---- Step 3: draw everything ---------------------------------------------------

function drawTrails(ctx: CanvasRenderingContext2D, time: number) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowBlur = GLOW_BLUR

  for (const [key, points] of history) {
    const tip = Number(key.split('-')[1])
    const color = COLORS[FINGERTIPS.indexOf(tip)]
    ctx.strokeStyle = color
    ctx.shadowColor = color

    // Split the point list into separate strokes wherever there's a time gap
    // (the finger was lost for a while), then draw each stroke on its own.
    let strokeStart = 0
    for (let i = 1; i <= points.length; i++) {
      const isEnd = i === points.length
      const isGap = !isEnd && points[i].t - points[i - 1].t > MAX_GAP_MS
      if (isEnd || isGap) {
        drawStroke(ctx, points.slice(strokeStart, i), time)
        strokeStart = i
      }
    }
  }

  ctx.restore()
}

/**
 * Draws one continuous stroke through `points`, with width and opacity
 * decreasing along its length according to each point's age.
 *
 * To get smooth curves rather than a jagged polyline, each piece runs from the
 * midpoint of one segment to the midpoint of the next, using the shared point
 * as the curve's control point. This is the classic "quadratic through
 * midpoints" trick and it guarantees the pieces join up without kinks.
 *
 * Each piece is stroked separately so it can have its own width/alpha.
 */
function drawStroke(ctx: CanvasRenderingContext2D, points: TrailPoint[], time: number) {
  if (points.length < 2) return

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const curr = points[i]
    const next = points[i + 1]

    // 0 = brand new, 1 = about to disappear.
    const age = Math.min(1, (time - curr.t) / FADE_MS)
    const life = 1 - age

    ctx.globalAlpha = life
    ctx.lineWidth = Math.max(0.5, MAX_WIDTH * life)

    ctx.beginPath()
    if (i === 1) {
      // First piece: start exactly at the oldest point.
      ctx.moveTo(prev.x, prev.y)
    } else {
      ctx.moveTo((prev.x + curr.x) / 2, (prev.y + curr.y) / 2)
    }

    if (next) {
      // Curve towards the midpoint of the *next* segment, bending around curr.
      ctx.quadraticCurveTo(curr.x, curr.y, (curr.x + next.x) / 2, (curr.y + next.y) / 2)
    } else {
      // Last piece: finish exactly at the newest point (the fingertip).
      ctx.lineTo(curr.x, curr.y)
    }
    ctx.stroke()
  }
}
