import type { IncomingMessage, ServerResponse } from 'node:http'

const USNO_ONEDAY_URL = 'https://aa.usno.navy.mil/api/rstt/oneday'

const USNO_FETCH_HEADERS = {
  Accept: 'application/json',
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

function queryValue(url: URL, key: string): string {
  return (url.searchParams.get(key) ?? '').trim()
}

function isDateParam(value: string): boolean {
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(value)
}

function isCoordsParam(value: string): boolean {
  return /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(value)
}

function isTzParam(value: string): boolean {
  const n = Number(value)
  return Number.isFinite(n) && n >= -12 && n <= 14
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
  const date = queryValue(url, 'date')
  const coords = queryValue(url, 'coords')
  const tz = queryValue(url, 'tz')

  if (!isDateParam(date) || !isCoordsParam(coords) || !isTzParam(tz)) {
    sendJson(
      res,
      400,
      { error: 'Invalid USNO query. Required: date, coords, tz.' },
      'no-store',
    )
    return
  }

  const upstream = new URL(USNO_ONEDAY_URL)
  upstream.searchParams.set('date', date)
  upstream.searchParams.set('coords', coords)
  upstream.searchParams.set('tz', tz)
  upstream.searchParams.set('ID', 'CoastCst')

  try {
    const usnoRes = await fetch(upstream.toString(), {
      headers: USNO_FETCH_HEADERS,
      signal: AbortSignal.timeout(12_000),
    })

    if (!usnoRes.ok) {
      sendJson(
        res,
        502,
        {
          error: `USNO responded with ${usnoRes.status}`,
          detail: `Could not load ${USNO_ONEDAY_URL}`,
        },
        CACHE_ERROR,
      )
      return
    }

    let data: unknown
    try {
      data = await usnoRes.json()
    } catch {
      sendJson(
        res,
        502,
        {
          error: 'USNO returned a non-JSON response',
          detail: `Could not parse ${USNO_ONEDAY_URL}`,
        },
        CACHE_ERROR,
      )
      return
    }

    sendJson(res, 200, data, CACHE_SUCCESS)
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Unknown error'
    sendJson(
      res,
      502,
      {
        error: 'Failed to fetch USNO one-day sun/moon data',
        detail,
      },
      CACHE_ERROR,
    )
  }
}
