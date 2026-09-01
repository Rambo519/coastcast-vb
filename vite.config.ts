import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const NHC_ORIGIN = 'https://www.nhc.noaa.gov'
const NHC_FETCH_HEADERS = {
  Accept: '*/*',
  'User-Agent': 'CoastCastVB/0.1 (Virginia Beach dashboard; educational use)',
} as const

function isAllowedNhcPath(pathname: string): boolean {
  if (!pathname.startsWith('/')) return false
  if (pathname.includes('..') || pathname.includes('//')) return false
  return (
    pathname.startsWith('/text/') ||
    pathname.startsWith('/storm_graphics/') ||
    pathname.startsWith('/gis/')
  )
}

function nhcFileDevProxy(): Plugin {
  return {
    name: 'nhc-file-dev-proxy',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
        const raw = req.url ?? ''
        if (!raw.startsWith('/api/nhc-file')) {
          next()
          return
        }

        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
          res.statusCode = 405
          res.setHeader('Allow', 'GET, HEAD')
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        const url = new URL(raw, 'http://localhost')
        const path = (url.searchParams.get('path') ?? '').trim()
        if (!isAllowedNhcPath(path)) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid NHC product path' }))
          return
        }

        const upstream = `${NHC_ORIGIN}${path}`
        void (async () => {
          try {
            const nhcRes = await fetch(upstream, {
              headers: NHC_FETCH_HEADERS,
              signal: AbortSignal.timeout(12_000),
            })
            if (!nhcRes.ok) {
              res.statusCode = 502
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(
                JSON.stringify({
                  error: `NHC responded with ${nhcRes.status}`,
                  detail: `Could not load ${upstream}`,
                }),
              )
              return
            }
            const buf = Buffer.from(await nhcRes.arrayBuffer())
            res.statusCode = 200
            res.setHeader(
              'Content-Type',
              nhcRes.headers.get('content-type') ?? 'application/octet-stream',
            )
            if (method === 'HEAD') {
              res.end()
              return
            }
            res.end(buf)
          } catch (e) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(
              JSON.stringify({
                error: 'Failed to fetch official NHC product',
                detail: e instanceof Error ? e.message : 'Unknown error',
              }),
            )
          }
        })()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), nhcFileDevProxy()],
  server: {
    // Dev-only: browser calls same-origin `/api/...`; Vite forwards to NHC (avoids CORS).
    proxy: {
      '/api/nhc-current-storms': {
        target: 'https://www.nhc.noaa.gov',
        changeOrigin: true,
        rewrite: () => '/CurrentStorms.json',
      },
      '/api/usno-oneday': {
        target: 'https://aa.usno.navy.mil',
        changeOrigin: true,
        rewrite: () => '/api/rstt/oneday',
      },
    },
  },
})
