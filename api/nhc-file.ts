import type { IncomingMessage, ServerResponse } from 'node:http'

const NHC_ORIGIN = 'https://www.nhc.noaa.gov'

const NHC_FETCH_HEADERS = {
  Accept: '*/*',
  'User-Agent': 'CoastCastVB/0.1 (Virginia Beach dashboard; educational use)',
} as const

const CACHE_SUCCESS = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600'
const CACHE_ERROR = 'public, max-age=0, s-maxage=60'

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  cacheControl: string,
): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', cacheControl)
  res.end(JSON.stringify(body))
}

function isAllowedNhcPath(pathname: string): boolean {
  if (!pathname.startsWith('/')) return false
  if (pathname.includes('..') || pathname.includes('//')) return false
  return (
    pathname.startsWith('/text/') ||
    pathname.startsWith('/storm_graphics/') ||
    pathname.startsWith('/gis/')
  )
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    sendJson(res, 405, { error: 'Method not allowed' }, 'no-store')
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = (url.searchParams.get('path') ?? '').trim()
  if (!isAllowedNhcPath(path)) {
    sendJson(res, 400, { error: 'Invalid NHC product path' }, 'no-store')
    return
  }

  const upstream = `${NHC_ORIGIN}${path}`

  try {
    const nhcRes = await fetch(upstream, {
      headers: NHC_FETCH_HEADERS,
      signal: AbortSignal.timeout(12_000),
    })

    if (!nhcRes.ok) {
      sendJson(
        res,
        502,
        {
          error: `NHC responded with ${nhcRes.status}`,
          detail: `Could not load ${upstream}`,
        },
        CACHE_ERROR,
      )
      return
    }

    const buf = Buffer.from(await nhcRes.arrayBuffer())
    const contentType =
      nhcRes.headers.get('content-type') ?? 'application/octet-stream'
    res.statusCode = 200
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', CACHE_SUCCESS)
    if (method === 'HEAD') {
      res.end()
      return
    }
    res.end(buf)
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Unknown error'
    sendJson(
      res,
      502,
      {
        error: 'Failed to fetch official NHC product',
        detail,
      },
      CACHE_ERROR,
    )
  }
}
