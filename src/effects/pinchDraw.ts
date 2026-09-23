import type { Effect, HandLandmarks } from './types'

/**
 * "Pinch Draw" effect: pinch your thumb and index finger together to draw a
 * line in the air. Release to stop. Press C to clear.
 *
 * The core idea: every frame we measure how close the thumb tip and index tip
 * are. When they get close enough we start a stroke at the point between them
 * and keep appending to it until they separate again. Finished strokes are
 * kept in memory and redrawn every frame (the canvas is cleared each frame).
 */

// ---- Tunables ----------------------------------------------------------------

/**
 * Pinch thresholds, as a fraction of the hand's size (see `handSize`).
 * Using a ratio rather than raw pixels means it works the same whether your
 * hand is close to the camera (big) or far away (small).
 *
 * Two thresholds = hysteresis: you must go *below* START to begin drawing,
 * and *above* STOP to stop. The gap between them prevents the line from
 * flickering on/off when your fingers hover right at the edge.
 */
const PINCH_START = 0.3
const PINCH_STOP = 0.45

/**
 * How much of the new position to use each frame (0..1). Lower = smoother but
 * laggier. 0.5 means "average the new position with the previous one".
 */
const SMOOTHING = 0.5

const LINE_WIDTH = 6
const GLOW_BLUR = 12
const CURSOR_RADIUS = 10

/** One colour per hand index. MediaPipe reports up to two hands. */
const HAND_COLORS = ['#00e5ff', '#ff3d81']

// ---- State -------------------------------------------------------------------

interface Point {
  x: number
  y: number
}

interface Stroke {
  color: string
  points: Point[]
}

/** Per-hand tracking state. Index 0 and 1 correspond to MediaPipe's hand order. */
interface HandState {
  /** Are we currently drawing with this hand? */
  pinching: boolean
  /** Smoothed pinch point, in canvas pixels. null until first seen. */
  cursor: Point | null
  /** The stroke being drawn right now, if any. */
  currentStroke: Stroke | null
  /** Was this hand present in the latest frame? Used to draw the cursor. */
  visible: boolean
}

/** Completed strokes. These persist until the user presses C. */
let strokes: Stroke[] = []

const handStates: HandState[] = [newHandState(), newHandState()]

function newHandState(): HandState {
  return { pinching: false, cursor: null, currentStroke: null, visible: false }
}

/** Keyboard handler; stored so cleanup() can remove the exact same function. */
function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'c' || event.key === 'C') {
    strokes = []
    // Also drop any stroke in progress so it doesn't survive the clear.
    for (const hand of handStates) hand.currentStroke = null
  }
}

// ---- The effect --------------------------------------------------------------

export const pinchDraw: Effect = {
  name: 'Pinch Draw',

  init() {
    window.addEventListener('keydown', onKeyDown)
  },

  draw(ctx, hands) {
    updateHands(ctx, hands)
    drawStrokes(ctx)
    drawCursors(ctx)
    drawHint(ctx)
  },

  cleanup() {
    window.removeEventListener('keydown', onKeyDown)
    // Finish any stroke in progress, but keep the drawing itself so it's still
    // there if you come back to this tab. Change this to `strokes = []` if you
    // would rather start with a blank canvas each time.
    for (let i = 0; i < handStates.length; i++) {
      finishStroke(handStates[i])
      handStates[i] = newHandState()
    }
  },
}

// ---- Step 1: read the hands and update pinch state ---------------------------

function updateHands(ctx: CanvasRenderingContext2D, hands: HandLandmarks[]) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height

  for (let i = 0; i < handStates.length; i++) {
    const state = handStates[i]
    const hand = hands[i]

    // Hand not in frame: if it was mid-stroke, end the stroke there.
    if (!hand) {
      state.visible = false
      if (state.pinching) {
        finishStroke(state)
        state.pinching = false
      }
      continue
    }
    state.visible = true

    // Convert the landmarks we need to pixels. We must do this *before*
    // measuring distances: normalized x is a fraction of the width and y a
    // fraction of the height, so on a 16:9 video a "diagonal" in normalized
    // space is not the same length as one in real pixels.
    const thumb = toPixels(hand, 4, w, h)
    const index = toPixels(hand, 8, w, h)
    const wrist = toPixels(hand, 0, w, h)
    const middleBase = toPixels(hand, 9, w, h)

    // Pinch ratio: gap between the two tips, relative to palm length.
    const handSize = Math.hypot(middleBase.x - wrist.x, middleBase.y - wrist.y) || 1
    const pinchRatio = Math.hypot(index.x - thumb.x, index.y - thumb.y) / handSize

    // The raw pinch point is the midpoint between the two tips. Smooth it by
    // blending with the previous cursor position to take the shake out.
    const raw = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 }
    state.cursor = state.cursor
      ? {
          x: state.cursor.x + (raw.x - state.cursor.x) * SMOOTHING,
          y: state.cursor.y + (raw.y - state.cursor.y) * SMOOTHING,
        }
      : raw

    // Hysteresis: which threshold applies depends on the current state.
    if (!state.pinching && pinchRatio < PINCH_START) {
      state.pinching = true
      state.currentStroke = { color: HAND_COLORS[i], points: [] }
    } else if (state.pinching && pinchRatio > PINCH_STOP) {
      state.pinching = false
      finishStroke(state)
    }

    if (state.pinching && state.currentStroke) {
      state.currentStroke.points.push({ ...state.cursor })
    }
  }
}

function toPixels(hand: HandLandmarks, index: number, w: number, h: number): Point {
  return { x: hand[index].x * w, y: hand[index].y * h }
}

/** Move the in-progress stroke (if any) into the finished list. */
function finishStroke(state: HandState) {
  if (state.currentStroke && state.currentStroke.points.length > 1) {
    strokes.push(state.currentStroke)
  }
  state.currentStroke = null
}

// ---- Step 2: draw the strokes --------------------------------------------------

function drawStrokes(ctx: CanvasRenderingContext2D) {
  ctx.save()
  ctx.lineWidth = LINE_WIDTH
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowBlur = GLOW_BLUR

  // Finished strokes first, then whatever each hand is drawing right now.
  const inProgress = handStates.map((s) => s.currentStroke).filter((s): s is Stroke => s !== null)
  for (const stroke of [...strokes, ...inProgress]) {
    if (stroke.points.length < 2) continue
    ctx.strokeStyle = stroke.color
    ctx.shadowColor = stroke.color
    ctx.beginPath()
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y)
    }
    ctx.stroke()
  }

  ctx.restore()
}

// ---- Step 3: draw a cursor at each hand's pinch point -------------------------

function drawCursors(ctx: CanvasRenderingContext2D) {
  ctx.save()
  ctx.lineWidth = 2

  handStates.forEach((state, i) => {
    if (!state.visible || !state.cursor) return
    const color = HAND_COLORS[i]
    ctx.beginPath()
    ctx.arc(state.cursor.x, state.cursor.y, CURSOR_RADIUS, 0, Math.PI * 2)
    if (state.pinching) {
      // Filled = drawing.
      ctx.fillStyle = color
      ctx.fill()
    } else {
      // Hollow = ready, not drawing.
      ctx.strokeStyle = color
      ctx.stroke()
    }
  })

  ctx.restore()
}

// ---- Step 4: on-screen hint ------------------------------------------------------

function drawHint(ctx: CanvasRenderingContext2D) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height

  ctx.save()
  // The canvas is mirrored with CSS (transform: scaleX(-1)) so that landmarks
  // line up with the mirrored video. Text drawn normally would therefore
  // appear backwards. Flipping the drawing context horizontally cancels the
  // CSS mirror for anything drawn after this point. The two flips undo each
  // other, so from here on x coordinates match what you see on screen:
  // x = 0 is the visible left edge and x = w the visible right edge.
  ctx.translate(w, 0)
  ctx.scale(-1, 1)

  ctx.font = '16px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
  // Bottom-right corner (the FPS badge already lives top-left).
  ctx.fillText('Pinch to draw · C to clear', w - 16, h - 12)

  ctx.restore()
}
