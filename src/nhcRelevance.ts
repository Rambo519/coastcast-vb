/** Official NHC product helpers — CurrentStorms.json + TCM + GIS KMZ. */

export type NhcProductRef = {
  advNum?: string
  issuance?: string
  url?: string
  zipFile?: string
  kmzFile?: string
} | null

export type NhcStorm = {
  id?: string
  binNumber?: string
  name?: string
  classification?: string
  intensity?: number | string
  pressure?: number | string
  latitude?: string
  longitude?: string
  latitudeNumeric?: number
  latitude_numeric?: number
  longitudeNumeric?: number
  longitude_numeric?: number
  lastUpdate?: string
  publicAdvisory?: NhcProductRef
  forecastAdvisory?: NhcProductRef
  forecastGraphics?: NhcProductRef
  forecastTrack?: NhcProductRef
  trackCone?: NhcProductRef
  windWatchesWarnings?: NhcProductRef
}

export type NhcLatLon = { lat: number; lon: number }

export type NhcStormProducts = {
  trackPoints: NhcLatLon[]
  coneRings: NhcLatLon[][]
  coneKnown: boolean
  wwKnown: boolean
  wwIssued: boolean
}

export type TropicalWw = 'warning' | 'watch' | null

export type HurricaneRelevance = 'CLEAR' | 'MONITOR' | 'ELEVATED' | 'HIGH'

export type HurricaneTrend = 'Approaching' | 'Moving away' | 'Little change' | 'n/a'

export type HurricaneEval = {
  storm: NhcStorm
  headline: string
  currentMiles: number | null
  closestForecastMiles: number | null
  cone: 'Inside' | 'Outside' | 'Unavailable'
  watchWarning: string
  trend: HurricaneTrend
  relevance: HurricaneRelevance
  officialUrl: string | null
}

const NHC_FILE_URL = '/api/nhc-file'
const EARTH_MI = 3958.7613
const TREND_DELTA_MI = 25

const NHC_HOSTS = new Set([
  'www.nhc.noaa.gov',
  'nhc.noaa.gov',
  'www.hurricanes.gov',
  'hurricanes.gov',
])

export function isAtlanticNhcStorm(s: NhcStorm): boolean {
  const bin = (s.binNumber ?? '').toUpperCase()
  if (bin.startsWith('AT')) return true
  const sid = (s.id ?? '').toLowerCase()
  return sid.startsWith('al')
}

export function nhcClassificationLabel(code: string | null | undefined): string {
  if (!code) return 'system'
  const u = code.toUpperCase()
  const labels: Record<string, string> = {
    TD: 'Tropical depression',
    TS: 'Tropical storm',
    HU: 'Hurricane',
    STD: 'Subtropical depression',
    STS: 'Subtropical storm',
    PTC: 'Potential tropical cyclone',
    PC: 'Post-tropical cyclone',
  }
  return labels[u] ?? u
}

export function stormHeadline(s: NhcStorm): string {
  const name = (s.name && s.name.trim()) || 'Unnamed'
  const cls = (s.classification ?? '').toUpperCase()
  if (cls === 'HU') return `Hurricane ${name}`
  if (cls === 'TS') return `Tropical Storm ${name}`
  if (cls === 'TD') return `Tropical Depression ${name}`
  if (cls === 'STS') return `Subtropical Storm ${name}`
  if (cls === 'STD') return `Subtropical Depression ${name}`
  if (cls === 'PTC') return `Potential Tropical Cyclone ${name}`
  if (cls === 'PC') return `Post-tropical ${name}`
  const labeled = nhcClassificationLabel(s.classification)
  return labeled === 'system' ? name : `${labeled} ${name}`
}

export function nhcOfficialForecastUrl(s: NhcStorm): string | null {
  const candidates = [s.forecastGraphics?.url, s.publicAdvisory?.url, s.forecastAdvisory?.url]
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const url = raw.trim()
    if (!url) continue
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') return url
    } catch {
      /* skip */
    }
  }
  return null
}

export function nhcFiniteNumber(value: number | string | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function stormCenter(s: NhcStorm): NhcLatLon | null {
  const latNum = nhcFiniteNumber(s.latitudeNumeric ?? s.latitude_numeric)
  const lonNum = nhcFiniteNumber(s.longitudeNumeric ?? s.longitude_numeric)
  if (latNum != null && lonNum != null && Math.abs(latNum) <= 90 && Math.abs(lonNum) <= 180) {
    return { lat: latNum, lon: lonNum }
  }
  const lat = parseHemisphereCoord(s.latitude)
  const lon = parseHemisphereCoord(s.longitude)
  if (lat == null || lon == null) return null
  return { lat, lon }
}

function parseHemisphereCoord(raw: string | undefined): number | null {
  if (!raw) return null
  const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/i)
  if (!m) return null
  let n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const hemi = (m[2] ?? '').toUpperCase()
  if (hemi === 'S' || hemi === 'W') n = -Math.abs(n)
  if (hemi === 'N' || hemi === 'E') n = Math.abs(n)
  return n
}

export function haversineMiles(a: NhcLatLon, b: NhcLatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function formatMiles(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  return `${Math.round(n)} mi`
}

export function relevancePlacePhrase(
  usingCurrentLocation: boolean,
  placeLabel: string | null,
): string {
  if (usingCurrentLocation) return placeLabel ?? 'your location'
  return 'Virginia Beach, VA'
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

export function nhcProxyUrl(officialUrl: string | null | undefined): string | null {
  if (!officialUrl) return null
  try {
    const u = new URL(officialUrl)
    if (!NHC_HOSTS.has(u.hostname.toLowerCase())) return null
    if (!isAllowedNhcPath(u.pathname)) return null
    return `${NHC_FILE_URL}?path=${encodeURIComponent(u.pathname)}`
  } catch {
    return null
  }
}

function decodeLatLon(lat: number, ns: string, lon: number, ew: string): NhcLatLon | null {
  const la = ns.toUpperCase() === 'S' ? -Math.abs(lat) : Math.abs(lat)
  const lo = ew.toUpperCase() === 'W' ? -Math.abs(lon) : Math.abs(lon)
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null
  return { lat: la, lon: lo }
}

/** Official NHC Forecast/Advisory (TCM) forecast and outlook points. */
export function parseTcmTrackPoints(text: string): NhcLatLon[] {
  const plain = text.replace(/<[^>]+>/g, '\n')
  const re =
    /(?:FORECAST|OUTLOOK)\s+VALID\s+\S+\s+(\d+(?:\.\d+)?)([NS])\s+(\d+(?:\.\d+)?)([EW])/gi
  const points: NhcLatLon[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(plain)) !== null) {
    const pt = decodeLatLon(Number(m[1]), m[2], Number(m[3]), m[4])
    if (pt) points.push(pt)
  }
  return points
}

function parseKmlCoordTuples(raw: string): NhcLatLon[] {
  const points: NhcLatLon[] = []
  for (const token of raw.trim().split(/[\s\n]+/)) {
    if (!token.includes(',')) continue
    const [lonS, latS] = token.split(',')
    const lon = Number(lonS)
    const lat = Number(latS)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
    points.push({ lat, lon })
  }
  return points
}

export function parseKmlPolygons(kml: string): NhcLatLon[][] {
  const rings: NhcLatLon[][] = []
  const polyRe = /<Polygon\b[\s\S]*?<\/Polygon>/gi
  let poly: RegExpExecArray | null
  while ((poly = polyRe.exec(kml)) !== null) {
    const coordRe = /<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/gi
    let coord: RegExpExecArray | null
    while ((coord = coordRe.exec(poly[0])) !== null) {
      const ring = parseKmlCoordTuples(coord[1])
      if (ring.length >= 4) rings.push(ring)
    }
  }
  return rings
}

export function parseKmlPoints(kml: string): NhcLatLon[] {
  const points: NhcLatLon[] = []
  const re = /<Point\b[\s\S]*?<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(kml)) !== null) {
    const pts = parseKmlCoordTuples(m[1])
    if (pts[0]) points.push(pts[0])
  }
  return points
}

export function kmlHasWatchWarningFeatures(kml: string): boolean {
  return /<(?:LineString|Polygon|Placemark)\b/i.test(kml)
}

export function pointInPolygon(point: NhcLatLon, ring: NhcLatLon[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat
    const xi = ring[i].lon
    const yj = ring[j].lat
    const xj = ring[j].lon
    const denom = yj - yi
    if (denom === 0) continue
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / denom + xi
    if (intersect) inside = !inside
  }
  return inside
}

export function pointInAnyPolygon(point: NhcLatLon, rings: NhcLatLon[][]): boolean {
  return rings.some((ring) => pointInPolygon(point, ring))
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  const stream = new Blob([copy]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Minimal ZIP reader for official NHC KMZ (stored or deflated KML). */
export async function kmlFromKmz(buf: ArrayBuffer): Promise<string | null> {
  const bytes = new Uint8Array(buf)
  const view = new DataView(buf)
  let offset = 0
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break
    const flags = view.getUint16(offset + 6, true)
    const method = view.getUint16(offset + 8, true)
    let compSize = view.getUint32(offset + 18, true)
    const nameLen = view.getUint16(offset + 26, true)
    const extraLen = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen))
    const dataStart = nameStart + nameLen + extraLen
    if ((flags & 0x8) !== 0 && compSize === 0) break
    if (dataStart + compSize > bytes.length) break
    const data = bytes.subarray(dataStart, dataStart + compSize)
    offset = dataStart + compSize
    if (!name.toLowerCase().endsWith('.kml')) continue
    try {
      const raw = method === 0 ? data : method === 8 ? await inflateRaw(data) : null
      if (!raw) continue
      return new TextDecoder().decode(raw)
    } catch {
      return null
    }
  }
  return null
}

async function fetchNhcBytes(
  officialUrl: string,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  const proxy = nhcProxyUrl(officialUrl)
  if (!proxy) return null
  const res = await fetch(proxy, { signal, headers: { Accept: '*/*' } })
  if (!res.ok) return null
  return res.arrayBuffer()
}

async function fetchNhcText(officialUrl: string, signal: AbortSignal): Promise<string | null> {
  const buf = await fetchNhcBytes(officialUrl, signal)
  if (!buf) return null
  return new TextDecoder().decode(buf)
}

async function fetchNhcKml(officialUrl: string, signal: AbortSignal): Promise<string | null> {
  const buf = await fetchNhcBytes(officialUrl, signal)
  if (!buf) return null
  const name = officialUrl.toLowerCase()
  if (name.endsWith('.kml')) return new TextDecoder().decode(buf)
  return kmlFromKmz(buf)
}

export function emptyStormProducts(): NhcStormProducts {
  return {
    trackPoints: [],
    coneRings: [],
    coneKnown: false,
    wwKnown: false,
    wwIssued: false,
  }
}

export async function loadStormProducts(
  storm: NhcStorm,
  signal: AbortSignal,
): Promise<NhcStormProducts> {
  const out = emptyStormProducts()
  const tcmUrl = storm.forecastAdvisory?.url
  const trackUrl = storm.forecastTrack?.kmzFile
  const coneUrl = storm.trackCone?.kmzFile
  const wwUrl = storm.windWatchesWarnings?.kmzFile
  const wwListed = storm.windWatchesWarnings != null && Boolean(wwUrl)

  const [tcmText, trackKml, coneKml, wwKml] = await Promise.all([
    tcmUrl ? fetchNhcText(tcmUrl, signal).catch(() => null) : Promise.resolve(null),
    trackUrl ? fetchNhcKml(trackUrl, signal).catch(() => null) : Promise.resolve(null),
    coneUrl ? fetchNhcKml(coneUrl, signal).catch(() => null) : Promise.resolve(null),
    wwUrl ? fetchNhcKml(wwUrl, signal).catch(() => null) : Promise.resolve(null),
  ])

  const fromTrack = trackKml ? parseKmlPoints(trackKml) : []
  const fromTcm = tcmText ? parseTcmTrackPoints(tcmText) : []
  out.trackPoints = fromTrack.length > 0 ? fromTrack : fromTcm

  if (coneKml) {
    out.coneRings = parseKmlPolygons(coneKml)
    out.coneKnown = out.coneRings.length > 0
  } else if (!coneUrl) {
    out.coneKnown = false
  }

  if (wwKml) {
    out.wwKnown = true
    out.wwIssued = kmlHasWatchWarningFeatures(wwKml)
  } else if (!wwListed) {
    out.wwKnown = true
    out.wwIssued = false
  }

  return out
}

export function tropicalWatchWarningFromAlerts(
  alerts: { properties?: { event?: string | null } | null }[],
): TropicalWw {
  let watch = false
  for (const a of alerts) {
    const event = (a.properties?.event ?? '').toLowerCase()
    if (!event) continue
    const tropical =
      event.includes('hurricane') ||
      event.includes('tropical storm') ||
      event.includes('storm surge') ||
      event.includes('tropical cyclone') ||
      event.includes('extreme wind')
    if (!tropical) continue
    if (event.includes('warning')) return 'warning'
    if (event.includes('watch')) watch = true
  }
  return watch ? 'watch' : null
}

function distanceBand(miles: number): HurricaneRelevance {
  if (miles >= 750) return 'CLEAR'
  if (miles >= 400) return 'MONITOR'
  if (miles >= 150) return 'ELEVATED'
  return 'HIGH'
}

const RANK: Record<HurricaneRelevance, number> = {
  CLEAR: 0,
  MONITOR: 1,
  ELEVATED: 2,
  HIGH: 3,
}

function raiseRelevance(label: HurricaneRelevance): HurricaneRelevance {
  if (label === 'CLEAR') return 'MONITOR'
  if (label === 'MONITOR') return 'ELEVATED'
  return 'HIGH'
}

export function forecastTrend(
  currentMiles: number | null,
  forecastMiles: number[],
): HurricaneTrend {
  if (forecastMiles.length === 0) return 'n/a'
  const first = forecastMiles[0]
  const last = forecastMiles[forecastMiles.length - 1]
  const closest = Math.min(...forecastMiles)
  const origin = currentMiles ?? first
  if (last + TREND_DELTA_MI < origin || closest + TREND_DELTA_MI < origin) {
    return 'Approaching'
  }
  if (last > origin + TREND_DELTA_MI && closest >= origin - 10) {
    return 'Moving away'
  }
  return 'Little change'
}

export function assignRelevance(input: {
  currentMiles: number | null
  closestForecastMiles: number | null
  insideCone: boolean
  ww: TropicalWw
}): HurricaneRelevance {
  const { currentMiles, closestForecastMiles, insideCone, ww } = input
  const distances = [currentMiles, closestForecastMiles].filter(
    (n): n is number => n != null && Number.isFinite(n),
  )
  let label: HurricaneRelevance = distances.length === 0 ? 'CLEAR' : distanceBand(Math.min(...distances))
  if (insideCone) label = raiseRelevance(label)
  if (ww === 'warning') return 'HIGH'
  if (ww === 'watch' && RANK[label] < RANK.ELEVATED) return 'ELEVATED'
  return label
}

function wwDisplay(ww: TropicalWw, products: NhcStormProducts | undefined): string {
  if (ww === 'warning') return 'Warning'
  if (ww === 'watch') return 'Watch'
  if (products?.wwKnown) return 'None'
  return 'Unavailable'
}

export function evaluateStorm(
  storm: NhcStorm,
  location: NhcLatLon,
  products: NhcStormProducts | undefined,
  ww: TropicalWw,
): HurricaneEval {
  const center = stormCenter(storm)
  const currentMiles = center ? haversineMiles(location, center) : null
  const forecastMiles = (products?.trackPoints ?? []).map((p) => haversineMiles(location, p))
  const closestForecastMiles =
    forecastMiles.length > 0 ? Math.min(...forecastMiles) : null
  const insideCone =
    Boolean(products?.coneKnown) && pointInAnyPolygon(location, products?.coneRings ?? [])
  const cone: HurricaneEval['cone'] = !products?.coneKnown
    ? 'Unavailable'
    : insideCone
      ? 'Inside'
      : 'Outside'

  return {
    storm,
    headline: stormHeadline(storm),
    currentMiles,
    closestForecastMiles,
    cone,
    watchWarning: wwDisplay(ww, products),
    trend: forecastTrend(currentMiles, forecastMiles),
    relevance: assignRelevance({
      currentMiles,
      closestForecastMiles,
      insideCone,
      ww,
    }),
    officialUrl: nhcOfficialForecastUrl(storm),
  }
}

export function compareEvals(a: HurricaneEval, b: HurricaneEval): number {
  const rank = RANK[b.relevance] - RANK[a.relevance]
  if (rank !== 0) return rank
  const aClose = Math.min(a.closestForecastMiles ?? Infinity, a.currentMiles ?? Infinity)
  const bClose = Math.min(b.closestForecastMiles ?? Infinity, b.currentMiles ?? Infinity)
  return aClose - bClose
}
