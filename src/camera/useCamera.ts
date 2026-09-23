import { useEffect, useState, type RefObject } from 'react'

/**
 * What state the camera is in. The UI uses this to show a spinner or an
 * error message instead of a black box.
 */
export type CameraStatus = 'requesting' | 'ready' | 'error'

export interface CameraState {
  status: CameraStatus
  /** Human-readable explanation when status === 'error'. */
  error: string | null
}

/**
 * Opens the user's webcam and pipes it into the <video> element you pass in.
 *
 * Usage:
 *   const videoRef = useRef<HTMLVideoElement>(null)
 *   const camera = useCamera(videoRef)
 *   <video ref={videoRef} autoPlay muted playsInline />
 *
 * The hook takes care of:
 *  - asking for permission (getUserMedia)
 *  - turning browser errors into friendly messages
 *  - stopping the camera when the component unmounts
 */
export function useCamera(videoRef: RefObject<HTMLVideoElement | null>): CameraState {
  const [state, setState] = useState<CameraState>({ status: 'requesting', error: null })

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    // React StrictMode runs effects twice in development. This flag lets the
    // first (thrown-away) run know it should not touch the video element.
    let cancelled = false
    let stream: MediaStream | null = null

    async function start() {
      // getUserMedia only exists on secure origins (https or localhost).
      if (!navigator.mediaDevices?.getUserMedia) {
        setState({
          status: 'error',
          error: 'Camera access is not available. Open this page over https:// or on localhost.',
        })
        return
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user', // front camera on phones
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
      } catch (err) {
        setState({ status: 'error', error: describeCameraError(err) })
        return
      }

      if (cancelled || !video) {
        // Component went away while we were waiting for permission.
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      video.srcObject = stream
      // `autoPlay` on the element usually handles this, but calling play()
      // explicitly is more reliable (and lets us await it).
      try {
        await video.play()
      } catch {
        // Autoplay can be blocked until the user interacts; the video will
        // still start once they click. Not worth treating as an error.
      }
      if (!cancelled) setState({ status: 'ready', error: null })
    }

    start()

    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    }
  }, [videoRef])

  return state
}

/** Map the DOMException names getUserMedia throws to something readable. */
function describeCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera permission was denied. Allow camera access in your browser and reload the page.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found on this device.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is already in use by another app. Close it and reload.'
    case 'OverconstrainedError':
      return 'No camera matched the requested settings.'
    default:
      return `Could not start the camera (${name || String(err)}).`
  }
}
