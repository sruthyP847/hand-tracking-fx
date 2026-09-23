import type { Effect } from './types'
import { skeleton } from './skeleton'
import { trails } from './trails'
import { pinchDraw } from './pinchDraw'
import { particles } from './particles'
import { handMask } from './handMask'

/** Every effect, in tab-bar order. Add new effects here. */
export const EFFECTS: Effect[] = [skeleton, trails, pinchDraw, particles, handMask]
