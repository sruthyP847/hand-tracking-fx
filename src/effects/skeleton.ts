import { HandLandmarker } from '@mediapipe/tasks-vision'
import type { Effect, HandLandmarks } from './types'

/**
 * Draws a line for each bone and a dot for each of the 21 landmarks.
 * Handy for debugging and as a starting point for other effects, which is
 * why `drawSkeleton` is exported separately from the Effect object.
 */
export function drawSkeleton(ctx: CanvasRenderingContext2D, hands: HandLandmarks[]) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height

  for (const hand of hands) {
    // Bones: HAND_CONNECTIONS is a list of {start, end} landmark index pairs.
    ctx.strokeStyle = '#00e5ff'
    ctx.lineWidth = 3
    ctx.beginPath()
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.moveTo(hand[start].x * w, hand[start].y * h)
      ctx.lineTo(hand[end].x * w, hand[end].y * h)
    }
    ctx.stroke()

    // Joints: a filled circle per landmark. Fingertips get a different colour.
    for (let i = 0; i < hand.length; i++) {
      const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20
      ctx.fillStyle = isTip ? '#ff3d81' : '#ffffff'
      ctx.beginPath()
      ctx.arc(hand[i].x * w, hand[i].y * h, isTip ? 7 : 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

export const skeleton: Effect = {
  name: 'Skeleton',
  draw(ctx, hands) {
    drawSkeleton(ctx, hands)
  },
}
