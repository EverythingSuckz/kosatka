import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/**
 * Dev-only middleware that serves the local AWC XXTEA key from
 * samples/.awc_key.json (gitignored). Registered via configureServer so it
 * does not leak into production builds — there's no way for the key to
 * reach the bundle.
 */
const devAwcKey = (): Plugin => ({
  name: 'awc-dev-key',
  configureServer(server) {
    server.middlewares.use('/__dev/awc-key.json', (_req, res) => {
      try {
        const path = resolve('samples/.awc_key.json')
        const data = readFileSync(path, 'utf-8')
        res.setHeader('Content-Type', 'application/json')
        res.end(data)
      } catch {
        res.statusCode = 404
        res.end()
      }
    })
  },
})

/**
 * Deployment model: fully static SPA (no server at runtime).
 *
 * The app has zero server-side functionality — parsing, decryption, key
 * derivation, MP3 decode, audio, and persistence all run in the browser.
 * `spa.enabled` makes TanStack Start prerender a client-shell index.html at
 * build time instead of emitting an SSR server; dynamic routes
 * (/mix/$sessionId, /rpf/$rpfId) are served by the host's SPA fallback (see
 * wrangler.jsonc `not_found_handling`). If a server becomes useful later
 * (optional integrations), re-add @cloudflare/vite-plugin and a worker
 * entry — nothing in the app assumes staticness.
 *
 * Offline: a hand-rolled service worker precaches the shell + all emitted
 * chunks (including the mp3 decoder worker) + public/ assets (including the
 * 154 KB magic.dat the key-derivation flow needs), so the app fully boots
 * with no network. Sessions + the derived key already persist in IndexedDB.
 * The SW is generated post-build by scripts/build-sw.ts (see `build` in
 * package.json) because plugin-based SW generation (vite-plugin-pwa) does
 * not understand TanStack Start's multi-environment vite build; the script
 * also copies the prerendered _shell.html to index.html, which Cloudflare's
 * SPA fallback requires. The manifest is a static file in public/.
 */
const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    devAwcKey(),
    tailwindcss(),
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
})

export default config
