import type { Effect, HandLandmarks } from './types'

/**
 * "Hand Mask" effect: the video is shown slightly dimmed and washed out,
 * except inside the silhouette of each hand, where it gets a stylised look
 * (rainbow, thermal or pixel-art). A soft glow hugs the outline of each hand.
 *
 * How it works, per frame:
 *   1. Draw the video onto the main canvas with a "dim + desaturate" filter.
 *      That's the background everyone sees.
 *   2. Paint a solid silhouette of every hand onto an offscreen MASK canvas
 *      (palm polygon + one fat round-capped line per finger).
 *   3. Draw the video onto an offscreen FX canvas with the chosen style's
 *      ctx.filter, then punch it out with the mask using the 'destination-in'
 *      composite mode. Only the pixels under the silhouette survive.
 *   4. Draw the mask onto the main canvas with a big shadowBlur (that's the
 *      glow), then draw the FX canvas on top so the styled video covers the
 *      solid silhouette and only the blurred halo peeks out around it.
 *   5. Draw the "1 Rainbow · 2 Thermal · 3 Pixelate" hint, un-mirrored.
 *
 * Everything runs through drawImage + ctx.filter + composite modes, which
 * the browser does on the GPU. There is no getImageData and no per-pixel
 * JavaScript, so it comfortably stays at camera frame rate.
 */

// ---- Tunables ----------------------------------------------------------------

/** The three looks. Number keys 1/2/3 switch between them. */
type Style = 'rainbow' | 'thermal' | 'pixelate'

const STYLES: Style[] = ['rainbow', 'thermal', 'pixelate']

/** Labels for the hint, in the same order as STYLES. */
const STYLE_LABELS = ['1 Rainbow', '2 Thermal', '3 Pixelate']

/** Filter applied to the video *outside* the hands. */
const BACKGROUND_FILTER = 'brightness(0.55) saturate(0.35)'

/**
 * Finger thickness as a fraction of the hand size (wrist -> middle finger
 * base). A real finger is roughly a quarter of that length wide; slightly
 * more so the silhouette covers the finger rather than leaving skin peeking
 * out at the edges.
 */
const FINGER_WIDTH_RATIO = 0.26

/** Thumbs are chunkier than the other fingers. */
const THUMB_WIDTH_RATIO = 0.32

/**
 * Size of one "pixel" in the pixelate style, in canvas pixels. The video is
 * drawn at (1 / PIXEL_SIZE) scale and blown back up without smoothing.
 */
const PIXEL_SIZE = 14

/** Spread of the glow around each hand, in canvas pixels. */
const GLOW_BLUR = 22

/** Full rainbow cycle every 6 seconds (360 degrees / 6000 ms). */
const RAINBOW_DEG_PER_MS = 360 / 6000

/** Palm outline, in order around the palm: wrist, thumb base, then the four knuckles. */
const PALM = [0, 1, 5, 9, 13, 17]

/**
 * Each finger as a chain of landmarks, starting at its base on the palm so
 * the finger's line overlaps the palm polygon and there's no gap between them.
 */
const FINGERS = [
  [1, 2, 3, 4], // thumb
  [5, 6, 7, 8], // index
  [9, 10, 11, 12], // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
]

// ---- State -------------------------------------------------------------------

/** Which look is active. Persists across tab switches on purpose. */
let style: Style = 'rainbow'

/**
 * Offscreen canvases. Created lazily on the first frame and reused after
 * that; they're only resized when the video's size changes. Creating a canvas
 * every frame would be a huge and needless allocation.
 */
let maskCanvas: HTMLCanvasElement | null = null
let maskCtx: CanvasRenderingContext2D | null = null
let fxCanvas: HTMLCanvasElement | null = null
let fxCtx: CanvasRenderingContext2D | null = null
/** Tiny canvas the video is shrunk into for the pixelate style. */
let pixelCanvas: HTMLCanvasElement | null = null
let pixelCtx: CanvasRenderingContext2D | null = null

/** Kept so cleanup() can remove exactly the listener init() added. */
let keyListener: ((e: KeyboardEvent) => void) | null = null

// ---- The effect --------------------------------------------------------------

export const handMask: Effect = {
  name: 'Hand Mask',

  init() {
    keyListener = (e) => {
      // Leave browser shortcuts like Cmd+1 (switch tab) alone.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const index = ['1', '2', '3'].indexOf(e.key)
      if (index !== -1) style = STYLES[index]
    }
    window.addEventListener('keydown', keyListener)
  },

  draw(ctx, hands, video, time) {
    const w = ctx.canvas.width
    const h = ctx.canvas.height

    // Nothing to show until the camera has delivered at least one frame.
    if (w === 0 || h === 0 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return

    ensureOffscreenCanvases(w, h)

    // 1. Background: the plain video, dimmed and desaturated so the hands pop.
    ctx.save()
    ctx.filter = BACKGROUND_FILTER
    ctx.drawImage(video, 0, 0, w, h)
    ctx.restore()

    if (hands.length > 0) {
      const glowColor = glowColorFor(style, time)

      // 2. Silhouettes -> mask canvas.
      drawMask(maskCtx!, hands, w, h, glowColor)

      // 3. Styled video, cut out with the mask -> fx canvas.
      drawStyledVideo(fxCtx!, video, w, h, time)
      fxCtx!.globalCompositeOperation = 'destination-in'
      fxCtx!.drawImage(maskCanvas!, 0, 0)
      fxCtx!.globalCompositeOperation = 'source-over'

      // 4a. Glow: the solid mask drawn with a soft shadow of the same colour.
      ctx.save()
      ctx.shadowColor = glowColor
      ctx.shadowBlur = GLOW_BLUR
      ctx.drawImage(maskCanvas!, 0, 0)
      ctx.restore()

      // 4b. The styled hands go on top, hiding the solid mask underneath.
      //     Because the fx canvas' edge is anti-aliased, a hair of the mask
      //     colour shows through at the very edge, which reads as an outline.
      ctx.drawImage(fxCanvas!, 0, 0)
    }

    // 5. Hint, drawn last so nothing covers it.
    drawHint(ctx, w, h)
  },

  cleanup() {
    if (keyListener) window.removeEventListener('keydown', keyListener)
    keyListener = null
    // The offscreen canvases are deliberately kept: they're cheap to hold on
    // to and it avoids re-allocating them every time the tab is reselected.
  },
}

// ---- Offscreen canvases --------------------------------------------------------

/**
 * Creates the offscreen canvases on first use and resizes them if the video's
 * resolution changed (e.g. the camera switched from 640x480 to 1280x720).
 * Setting a canvas' width/height also clears it, which is why we only do it
 * when the size actually differs.
 */
function ensureOffscreenCanvases(w: number, h: number) {
  if (!maskCanvas) {
    maskCanvas = document.createElement('canvas')
    maskCtx = maskCanvas.getContext('2d')!
    fxCanvas = document.createElement('canvas')
    fxCtx = fxCanvas.getContext('2d')!
    pixelCanvas = document.createElement('canvas')
    pixelCtx = pixelCanvas.getContext('2d')!
  }

  if (maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas.width = w
    maskCanvas.height = h
    fxCanvas!.width = w
    fxCanvas!.height = h
    // Small enough that each of its pixels becomes a PIXEL_SIZE block.
    pixelCanvas!.width = Math.max(1, Math.round(w / PIXEL_SIZE))
    pixelCanvas!.height = Math.max(1, Math.round(h / PIXEL_SIZE))
  }
}

// ---- Step 2: the silhouette mask -------------------------------------------------

/**
 * Paints every hand as a solid shape onto the mask canvas. Only the alpha
 * channel matters for the 'destination-in' cut-out, but we fill in the glow
 * colour so the same canvas can double as the glow layer.
 */
function drawMask(mctx: CanvasRenderingContext2D, hands: HandLandmarks[], w: number, h: number, color: string) {
  mctx.clearRect(0, 0, w, h)
  mctx.fillStyle = color
  mctx.strokeStyle = color
  mctx.lineCap = 'round'
  mctx.lineJoin = 'round'

  for (const hand of hands) {
    // Hand size in pixels: wrist (0) to the base of the middle finger (9).
    // Everything else scales off this so hands near and far from the camera
    // get proportionally sized silhouettes.
    const handSize = Math.hypot((hand[9].x - hand[0].x) * w, (hand[9].y - hand[0].y) * h)
    const fingerWidth = handSize * FINGER_WIDTH_RATIO

    // Palm: fill the polygon, then stroke its outline with the same fat line
    // the fingers use. Landmarks sit in the *middle* of the knuckles, so the
    // bare polygon would be too skinny; the stroke pads it out and rounds
    // the corners.
    mctx.beginPath()
    PALM.forEach((i, n) => {
      const x = hand[i].x * w
      const y = hand[i].y * h
      if (n === 0) mctx.moveTo(x, y)
      else mctx.lineTo(x, y)
    })
    mctx.closePath()
    mctx.fill()
    mctx.lineWidth = fingerWidth
    mctx.stroke()

    // Fingers: one round-capped polyline through the joints of each finger.
    FINGERS.forEach((chain, fingerIndex) => {
      mctx.lineWidth = fingerIndex === 0 ? handSize * THUMB_WIDTH_RATIO : fingerWidth
      mctx.beginPath()
      chain.forEach((i, n) => {
        const x = hand[i].x * w
        const y = hand[i].y * h
        if (n === 0) mctx.moveTo(x, y)
        else mctx.lineTo(x, y)
      })
      mctx.stroke()
    })
  }
}

// ---- Step 3: the styled video ------------------------------------------------------

/**
 * Draws the whole video frame onto the fx canvas with the active style's
 * look. The mask is applied afterwards by the caller.
 */
function drawStyledVideo(fctx: CanvasRenderingContext2D, video: HTMLVideoElement, w: number, h: number, time: number) {
  fctx.clearRect(0, 0, w, h)

  switch (style) {
    case 'rainbow': {
      // Spin the hue with time; the extra saturation keeps the colours vivid
      // even on pale skin tones and dull lighting.
      const hue = (time * RAINBOW_DEG_PER_MS) % 360
      fctx.filter = `hue-rotate(${hue}deg) saturate(1.8) contrast(1.1)`
      fctx.drawImage(video, 0, 0, w, h)
      break
    }

    case 'thermal': {
      // Inverting turns bright skin dark and shadows bright; cranking contrast
      // and saturation on top of that gives the false-colour heat-camera feel.
      fctx.filter = 'invert(1) contrast(1.9) saturate(3) brightness(1.1)'
      fctx.drawImage(video, 0, 0, w, h)
      break
    }

    case 'pixelate': {
      // Shrink the video into the tiny canvas (this averages nearby pixels
      // into one), then blow it back up with smoothing off so every small
      // pixel becomes a crisp square block.
      const pw = pixelCanvas!.width
      const ph = pixelCanvas!.height
      pixelCtx!.drawImage(video, 0, 0, pw, ph)

      fctx.imageSmoothingEnabled = false
      fctx.filter = 'saturate(1.5) contrast(1.15)' // a bit of pixel-art punch
      fctx.drawImage(pixelCanvas!, 0, 0, pw, ph, 0, 0, w, h)
      fctx.imageSmoothingEnabled = true
      break
    }
  }

  // Never leave a filter on: it would also apply to the mask cut-out.
  fctx.filter = 'none'
}

/** Colour of the glow/outline for each style. Rainbow follows the hue. */
function glowColorFor(current: Style, time: number): string {
  switch (current) {
    case 'rainbow': {
      const hue = (time * RAINBOW_DEG_PER_MS) % 360
      return `hsl(${hue}, 100%, 65%)`
    }
    case 'thermal':
      return '#ff7a1a'
    case 'pixelate':
      return '#4ade80'
  }
}

// ---- Step 5: the hint --------------------------------------------------------------

/**
 * "1 Rainbow · 2 Thermal · 3 Pixelate" in the bottom-left corner, with the
 * active style highlighted.
 *
 * The canvas is mirrored with CSS (scaleX(-1)), so text drawn normally would
 * read backwards. We flip the context back the other way first: after
 * `translate(w, 0); scale(-1, 1)`, a point drawn at x lands at canvas pixel
 * (w - x), which the CSS mirror then shows at screen position x. Net effect:
 * we can draw as if nothing were mirrored.
 */
function drawHint(ctx: CanvasRenderingContext2D, w: number, h: number) {
  // Scale the text with the canvas so it looks the same at 640 and 1280 wide.
  const fontSize = Math.max(13, Math.round(h * 0.028))
  const padX = fontSize * 0.7
  const padY = fontSize * 0.45
  const margin = fontSize * 0.8
  const separator = '  ·  '

  ctx.save()
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.font = `500 ${fontSize}px ui-monospace, Menlo, monospace`
  ctx.textBaseline = 'middle'

  // Measure the whole line so the background pill fits it exactly.
  const fullText = STYLE_LABELS.join(separator)
  const textWidth = ctx.measureText(fullText).width
  const pillW = textWidth + padX * 2
  const pillH = fontSize + padY * 2
  const pillX = margin
  const pillY = h - margin - pillH

  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.beginPath()
  ctx.roundRect(pillX, pillY, pillW, pillH, pillH / 2)
  ctx.fill()

  // Draw label by label, advancing x by each piece's measured width, so the
  // active one can use a different colour than the rest.
  let x = pillX + padX
  const y = pillY + pillH / 2
  const activeIndex = STYLES.indexOf(style)

  STYLE_LABELS.forEach((label, i) => {
    ctx.fillStyle = i === activeIndex ? '#c084fc' : 'rgba(255, 255, 255, 0.6)'
    ctx.fillText(label, x, y)
    x += ctx.measureText(label).width

    if (i < STYLE_LABELS.length - 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
      ctx.fillText(separator, x, y)
      x += ctx.measureText(separator).width
    }
  })

  ctx.restore()
}
