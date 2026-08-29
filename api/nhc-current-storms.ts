import type { IncomingMessage, ServerResponse } from 'node:http'

const NHC_CURRENT_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json'

const NHC_FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'CoastCastVB/0.1 (Virginia Beach dashboard; educational use)',
} as const

/** CDN cache: clients revalidate with us; we avoid hitting NHC on every page load. */
const CACHE_SUCCESS = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600'
/** Short cache on failure so a NHC outage does not become a request stampede. */
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

  try {
    const nhcRes = await fetch(NHC_CURRENT_STORMS_URL, {
      headers: NHC_FETCH_HEADERS,
      signal: AbortSignal.timeout(12_000),
    })

    if (!nhcRes.ok) {
      sendJson(
        res,
        502,
        {
          error: `NHC responded with ${nhcRes.status}`,
          detail: `Could not load ${NHC_CURRENT_STORMS_URL}`,
        },
        CACHE_ERROR,
      )
      return
    }

    let data: unknown
    try {
      data = await nhcRes.json()
    } catch {
      sendJson(
        res,
        502,
        {
          error: 'NHC returned a non-JSON response',
          detail: `Could not parse ${NHC_CURRENT_STORMS_URL}`,
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
        error: 'Failed to fetch NHC CurrentStorms.json',
        detail,
      },
      CACHE_ERROR,
    )
  }
}
