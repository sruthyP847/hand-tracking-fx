import type { Effect } from './types'
import { drawSkeleton } from './skeleton'

/**
 * TODO: "Trails" effect. For now it just draws the debug skeleton.
 *
 * Tips when filling this in:
 *  - Keep per-frame state (previous positions, particles, ...) in variables
 *    at the top of this file, and reset them in cleanup().
 *  - hands[i][8] is the index fingertip, hands[i][4] the thumb tip.
 *  - The canvas is cleared before every draw() call. If you want things to
 *    persist between frames (like a trail), you'll need to draw them again
 *    each frame from the state you kept.
 */
export const trails: Effect = {
  name: 'Trails',
  init() {
    // Runs once when this tab is selected.
  },
  draw(ctx, hands, _video, _time) {
    drawSkeleton(ctx, hands)
  },
  cleanup() {
    // Runs once when switching to another tab.
  },
}
