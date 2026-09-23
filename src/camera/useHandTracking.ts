import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision'

/**
 * Where MediaPipe loads its files from.
 *
 * - WASM_BASE: the WebAssembly runtime, served from the jsDelivr CDN. The
 *   version here should match the one in package.json so the runtime and the
 *   JS bundle agree with each other.
 * - MODEL_URL: the trained hand landmark model, hosted by Google.
 */
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

export type TrackingStatus = 'loading' | 'ready' | 'error'

export interface TrackingState {
  status: TrackingStatus
  error: string | null
  /** Frames per second of the detection loop, updated a few times a second. */
  fps: number
}

/**
 * Called once per animation frame with the latest detection result.
 * `time` is a monotonically increasing clock in milliseconds (performance.now()).
 */
export type FrameCallback = (result: HandLandmarkerResult, time: number) => void

/**
 * Loads MediaPipe's HandLandmarker and runs it on the <video> element every
 * animation frame, as long as `enabled` is true (i.e. the camera is ready).
 *
 * The `onFrame` callback receives the raw landmarks; it is up to the caller
 * to draw something with them. The callback is stored in a ref so you can
 * pass a new function every render without restarting the tracking loop.
 */
export function useHandTracking(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  onFrame: FrameCallback,
): TrackingState {
  const [state, setState] = useState<TrackingState>({ status: 'loading', error: null, fps: 0 })

  // Keep the latest callback in a ref so it is not a dependency of the main
  // effect below (which would otherwise restart tracking on every render).
  const onFrameRef = useRef(onFrame)
  useEffect(() => {
    onFrameRef.current = onFrame
  })

  useEffect(() => {
    if (!enabled) return
    const video = videoRef.current
    if (!video) return

    let cancelled = false
    let landmarker: HandLandmarker | null = null
    let rafId = 0

    async function setup() {
      try {
        // 1. Fetch the WASM runtime.
        const vision = await FilesetResolver.forVisionTasks(WASM_BASE)

        // 2. Create the detector. GPU is much faster, but not every browser or
        //    machine supports it, so fall back to CPU if it throws.
        try {
          landmarker = await createLandmarker(vision, 'GPU')
        } catch (gpuErr) {
          console.warn('GPU delegate failed, falling back to CPU', gpuErr)
          landmarker = await createLandmarker(vision, 'CPU')
        }
      } catch (err) {
        if (!cancelled) {
          setState({ status: 'error', error: `Could not load hand tracking: ${String(err)}`, fps: 0 })
        }
        return
      }

      if (cancelled) {
        landmarker.close()
        return
      }

      setState({ status: 'ready', error: null, fps: 0 })
      rafId = requestAnimationFrame(loop)
    }

    // ---- The per-frame loop ------------------------------------------------
    let lastVideoTime = -1
    let frames = 0
    let fpsWindowStart = performance.now()

    function loop(now: number) {
      if (cancelled || !landmarker || !video) return
      rafId = requestAnimationFrame(loop)

      // Only run detection when the video actually has a new frame. Cameras
      // run at ~30fps while rAF runs at 60+, so this halves the work.
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime
        // MediaPipe needs a strictly increasing timestamp in "VIDEO" mode.
        const result = landmarker.detectForVideo(video, now)
        onFrameRef.current(result, now)
      }

      // FPS: count frames and publish the average every 500ms so we don't
      // trigger a React re-render on every single frame.
      frames++
      const elapsed = now - fpsWindowStart
      if (elapsed >= 500) {
        const fps = Math.round((frames * 1000) / elapsed)
        frames = 0
        fpsWindowStart = now
        setState((s) => (s.fps === fps ? s : { ...s, fps }))
      }
    }

    setup()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      landmarker?.close()
    }
  }, [videoRef, enabled])

  return state
}

function createLandmarker(vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>, delegate: 'GPU' | 'CPU') {
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
  })
}
