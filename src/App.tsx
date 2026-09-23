import { useCallback, useEffect, useRef, useState } from 'react'
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision'
import { useCamera } from './camera/useCamera'
import { useHandTracking } from './camera/useHandTracking'
import { EFFECTS } from './effects'
import type { Effect } from './effects/types'

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Which tab is selected. We keep the Effect object itself in a ref too, so
  // the frame loop can read it without React re-renders being involved.
  const [activeName, setActiveName] = useState(EFFECTS[0].name)
  const activeEffectRef = useRef<Effect>(EFFECTS[0])

  // 1. Camera -> <video>
  const camera = useCamera(videoRef)

  // 2. Called every frame with the detection result. Clears the canvas and
  //    hands off to whichever effect is active.
  const onFrame = useCallback((result: HandLandmarkerResult, time: number) => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    // Match the canvas' drawing resolution to the video's. Because both are
    // stretched to the same CSS box, this keeps landmarks perfectly aligned.
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    activeEffectRef.current.draw(ctx, result.landmarks, video, time)
  }, [])

  // 3. Hand tracking -> onFrame. Only starts once the camera is ready.
  const tracking = useHandTracking(videoRef, camera.status === 'ready', onFrame)

  // 4. Switching effects: cleanup() the old one, init() the new one.
  useEffect(() => {
    const next = EFFECTS.find((e) => e.name === activeName) ?? EFFECTS[0]
    const ctx = canvasRef.current?.getContext('2d')

    activeEffectRef.current = next
    if (ctx) next.init?.(ctx)

    return () => {
      next.cleanup?.()
    }
  }, [activeName])

  // What to show over the video, if anything.
  let overlay: { text: string; error?: boolean } | null = null
  if (camera.status === 'error') overlay = { text: camera.error ?? 'Camera error', error: true }
  else if (camera.status === 'requesting') overlay = { text: 'Waiting for camera permission…' }
  else if (tracking.status === 'error') overlay = { text: tracking.error ?? 'Tracking error', error: true }
  else if (tracking.status === 'loading') overlay = { text: 'Loading hand tracking model…' }

  return (
    <>
      <nav className="tabs">
        {EFFECTS.map((effect) => (
          <button
            key={effect.name}
            className={'tab' + (effect.name === activeName ? ' active' : '')}
            onClick={() => setActiveName(effect.name)}
          >
            {effect.name}
          </button>
        ))}
      </nav>

      <div className="stage">
        {/* muted + playsInline are needed for autoplay to work on mobile. */}
        <video ref={videoRef} autoPlay muted playsInline />
        <canvas ref={canvasRef} />

        {overlay && <div className={'overlay' + (overlay.error ? ' error' : '')}>{overlay.text}</div>}

        {tracking.status === 'ready' && <div className="fps">{tracking.fps} fps</div>}
      </div>
    </>
  )
}
