import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Normal `npm run build` produces a regular multi-file app (faster iteration).
// `npm run build:onefile` produces a single, fully self-contained index.html
// (all JS/CSS/worker assets inlined as data: URIs) that can be opened directly
// from disk or dropped into any static host — no server required.
export default defineConfig(({ mode }) => {
  const singlefile = mode === 'singlefile'
  return {
    plugins: [preact(), ...(singlefile ? [viteSingleFile()] : [])],
    build: {
      assetsInlineLimit: singlefile ? 100_000_000 : 4096,
      cssCodeSplit: !singlefile,
    },
  }
})
