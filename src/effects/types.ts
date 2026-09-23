import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

/**
 * One hand = 21 landmarks. Each landmark has x and y in the range 0..1
 * (a fraction of the video's width/height) plus a rough depth z.
 * Multiply x by canvas.width and y by canvas.height to get pixels.
 *
 * Landmark index reference:
 *   0 wrist
 *   1-4   thumb   (4 = tip)
 *   5-8   index   (8 = tip)
 *   9-12  middle  (12 = tip)
 *   13-16 ring    (16 = tip)
 *   17-20 pinky   (20 = tip)
 */
export type HandLandmarks = NormalizedLandmark[]

/**
 * A visual effect. The app calls:
 *   init(ctx)      once, when the effect is selected (optional)
 *   draw(...)      every frame, after the canvas has been cleared
 *   cleanup()      once, when switching away (optional) - use it to reset
 *                  any state you kept between frames (trails, particles...)
 */
export interface Effect {
  /** Label shown on the tab. */
  name: string
  init?(ctx: CanvasRenderingContext2D): void
  draw(
    ctx: CanvasRenderingContext2D,
    /** One entry per detected hand (0, 1 or 2 entries). */
    hands: HandLandmarks[],
    video: HTMLVideoElement,
    /** Milliseconds, keeps increasing; handy for animation. */
    time: number,
  ): void
  cleanup?(): void
}
