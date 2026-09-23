import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves project sites from https://<user>.github.io/<repo>/,
  // so every asset URL needs the "/hand-art/" prefix. This also applies in
  // dev: the app runs at http://localhost:5173/hand-art/
  base: '/hand-art/',
})
