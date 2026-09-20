import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { VitePWA } from 'vite-plugin-pwa'

// Normal `npm run build` produces a regular multi-file app (faster iteration).
// `npm run build:onefile` produces a single, fully self-contained index.html
// (all JS/CSS/worker assets inlined as data: URIs) that can be opened directly
// from disk or dropped into any static host — no server required.
//
// PWA support (manifest + service worker, for "Install app" / offline use on
// Android) only makes sense for the real, multi-file build that's actually
// deployed to a real origin (Firebase Hosting) — a `build:onefile` output is
// a single file opened straight off disk or embedded elsewhere, which is
// never something a browser can "install" as an app or register a service
// worker for (service workers require a real HTTPS origin, which a
// file:// or data:-URI page never has), so the plugin is only added for the
// non-singlefile build.
export default defineConfig(({ mode }) => {
  const singlefile = mode === 'singlefile'
  return {
    plugins: [
      preact(),
      ...(singlefile
        ? [viteSingleFile()]
        : [
            VitePWA({
              registerType: 'autoUpdate',
              includeAssets: ['favicon.svg'],
              manifest: {
                name: 'Marginal',
                short_name: 'Marginal',
                description: 'A local-first essay and source workbench.',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                background_color: '#ffffff',
                theme_color: '#7e14ff',
                icons: [
                  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
              },
              workbox: {
                // The default glob (js/css/html/ico/png/svg) misses pdf.js's
                // own worker script (`pdf.worker-*.mjs`, a couple MB on its
                // own) — everything actually needed offline (viewing an
                // already-downloaded source's PDF, not just the app shell)
                // has to be precached too, or the app "works offline" only
                // until the first PDF is opened.
                globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,woff,woff2}'],
                // Comfortably above the largest real asset (the pdf.worker
                // script) — the default 2 MiB cap would silently skip it.
                maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
                // This is a client-routed SPA (see firebase.json's own
                // rewrite of every path to /index.html for the same reason)
                // — an offline navigation to any path needs the same
                // fallback the real server gives it online.
                navigateFallback: '/index.html',
              },
            }),
          ]),
    ],
    build: {
      assetsInlineLimit: singlefile ? 100_000_000 : 4096,
      cssCodeSplit: !singlefile,
    },
  }
})
