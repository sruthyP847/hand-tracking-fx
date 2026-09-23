# hand-art

Webcam + MediaPipe hand tracking with swappable visual effects.

```sh
npm install
npm run dev      # http://localhost:5173/hand-art/
npm run build    # output in dist/, ready for GitHub Pages
```

Layout:

- `src/camera/useCamera.ts` – opens the webcam into a `<video>` element
- `src/camera/useHandTracking.ts` – loads MediaPipe HandLandmarker and runs it every frame
- `src/effects/` – one file per visual effect, all implementing the `Effect` interface in `types.ts`
- `src/App.tsx` – wires everything together and shows the effect tab bar
