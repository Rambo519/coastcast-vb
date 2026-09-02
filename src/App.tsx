import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  compareEvals,
  evaluateStorm,
  formatMiles,
  isAtlanticNhcStorm,
  loadStormProducts,
  relevancePlacePhrase,
  stormHeadline,
  tropicalWatchWarningFromAlerts,
  type HurricaneEval,
  type HurricaneRelevance,
  type HurricaneTrend,
  type NhcStorm,
  type NhcStormProducts,
} from './nhcRelevance'

const VB_LAT = 36.8529
const VB_LON = -75.978

const USE_MY_LOCATION_PREF_KEY = 'coastcast-use-my-location'
const CHOSE_VB_PREF_KEY = 'coastcast-chose-virginia-beach'
const LOCATION_ONBOARDED_PREF_KEY = 'coastcast-location-onboarded'
const MOBILE_LOC_MQ = '(max-width: 600px)'

function usgsQuakesUrl(lat: number, lon: number): string {
  const latitude = lat === VB_LAT && lon === VB_LON ? '36.8529' : lat.toFixed(4)
  const longitude = lat === VB_LAT && lon === VB_LON ? '-75.9780' : lon.toFixed(4)
  return `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${latitude}&longitude=${longitude}&maxradiuskm=805&minmagnitude=2.5&orderby=time&limit=20`
}

/** NOAA/NWS active alerts for a lat/lon point */
function nwsActiveAlertsUrl(lat: number, lon: number): string {
  const point =
    lat === VB_LAT && lon === VB_LON
      ? '36.8529,-75.9780'
      : `${lat.toFixed(4)},${lon.toFixed(4)}`
  return `https://api.weather.gov/alerts/active?point=${point}`
}

const NWS_FETCH_HEADERS = {
  Accept: 'application/geo+json',
  'User-Agent': 'CoastCastVB/0.1 (Virginia Beach dashboard; educational use)',
} as const

function isUsableHttpUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function nwsPointsUrl(lat: number, lon: number): string {
  const point =
    lat === VB_LAT && lon === VB_LON
      ? '36.8529,-75.9780'
      : `${lat.toFixed(4)},${lon.toFixed(4)}`
  return `https://api.weather.gov/points/${point}`
}

type NwsQuantity = {
  value?: number | null
}

type NwsForecastPeriod = {
  name?: string | null
  startTime?: string | null
  endTime?: string | null
  isDaytime?: boolean
  temperature?: number | null
  probabilityOfPrecipitation?: NwsQuantity | null
  relativeHumidity?: NwsQuantity | null
  icon?: string | null
  shortForecast?: string | null
}

type ForecastIconKind =
  | 'sun'
  | 'mostly-sun'
  | 'partly-cloud'
  | 'cloud'
  | 'showers'
  | 'rain'
  | 'storm'
  | 'snow'
  | 'fog'
  | 'wind'

type ForecastDay = {
  dayLabel: string
  condition: string
  icon: ForecastIconKind
  high: string
  rain: string
  humidity: string
}

function nwsQuantityValue(q: NwsQuantity | null | undefined): number | null {
  const v = q?.value
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function compactForecastLabel(raw: string): string {
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return '—'

  if (/(scattered|isolated).*(thunder|t-storm|storm)/.test(t)) return 'Scattered Storms'
  if (/thunder|t-storm|tstm/.test(t)) return 'Storms'
  if (/blizzard|heavy snow|snow|flurries|wintry/.test(t)) return 'Snow'
  if (/sleet|freezing rain|\bice\b/.test(t)) return 'Icy Mix'
  if (/\bfog\b|\bmist\b|\bhaze\b/.test(t)) return 'Fog'
  if (/shower/.test(t)) return 'Showers'
  if (/\brain\b|drizzle/.test(t)) return 'Rain'
  if (/mostly sunny|mostly clear/.test(t)) return 'Mostly Sunny'
  if (/partly cloudy|partly sunny/.test(t)) return 'Partly Cloudy'
  if (/mostly cloudy|considerable cloud/.test(t)) return 'Mostly Cloudy'
  if (/overcast|\bcloudy\b/.test(t)) return 'Cloudy'
  if (/sunny/.test(t)) return 'Sunny'
  if (/\bclear\b|\bfair\b/.test(t)) return 'Clear'
  if (/wind/.test(t)) return 'Windy'

  const cleaned = raw.trim().replace(/\s+/g, ' ')
  if (cleaned.length <= 22) return cleaned
  return `${cleaned.slice(0, 20).replace(/[,;:\s]+$/, '')}…`
}

function forecastIconKind(label: string, iconUrl: string | null): ForecastIconKind {
  const t = label.toLowerCase()
  const path = (iconUrl ?? '').toLowerCase()
  if (t.includes('storm') || path.includes('tsra') || path.includes('tornado')) return 'storm'
  if (t.includes('snow') || t.includes('icy') || /\/(?:sn|rsn|ip)/.test(path)) return 'snow'
  if (t.includes('fog') || /\/(?:fg|hz)/.test(path)) return 'fog'
  if (t.includes('shower') || path.includes('shra')) return 'showers'
  if (t.includes('rain') || /\/ra/.test(path)) return 'rain'
  if (t.includes('wind') || path.includes('wind')) return 'wind'
  if (t.includes('partly') || path.includes('/sct')) return 'partly-cloud'
  if (t.includes('mostly cloudy') || t === 'cloudy' || /\/(?:bkn|ovc)/.test(path)) {
    return 'cloud'
  }
  if (t.includes('mostly sunny') || path.includes('/few')) return 'mostly-sun'
  if (t === 'sunny' || t === 'clear' || path.includes('/skc')) return 'sun'
  if (t.includes('cloud')) return 'cloud'
  return 'partly-cloud'
}

function formatForecastDayLabel(
  startTime: string | null | undefined,
  fallbackName: string,
): string {
  if (startTime) {
    const d = new Date(startTime)
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
    }
  }
  const token = fallbackName.trim().split(/\s+/)[0] ?? ''
  return token.slice(0, 3).toUpperCase() || '—'
}

function formatForecastPct(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}%`
}

function humidityForDaytimePeriod(
  day: NwsForecastPeriod,
  hourly: NwsForecastPeriod[],
): number | null {
  const direct = nwsQuantityValue(day.relativeHumidity)
  if (direct != null) return direct

  const start = day.startTime ? Date.parse(day.startTime) : NaN
  if (!Number.isFinite(start)) return null
  const end = day.endTime ? Date.parse(day.endTime) : start + 12 * 60 * 60 * 1000

  let bestHum: number | null = null
  let bestTemp = -Infinity
  for (const hour of hourly) {
    const hs = hour.startTime ? Date.parse(hour.startTime) : NaN
    if (!Number.isFinite(hs) || hs < start || hs >= end) continue
    const hum = nwsQuantityValue(hour.relativeHumidity)
    if (hum == null) continue
    const temp =
      typeof hour.temperature === 'number' && Number.isFinite(hour.temperature)
        ? hour.temperature
        : -Infinity
    if (temp >= bestTemp) {
      bestTemp = temp
      bestHum = hum
    }
  }
  return bestHum
}

function pickDaytimeForecasts(
  periods: NwsForecastPeriod[],
  hourly: NwsForecastPeriod[],
): ForecastDay[] {
  const days: ForecastDay[] = []
  for (const period of periods) {
    if (period.isDaytime !== true) continue
    const high =
      typeof period.temperature === 'number' && Number.isFinite(period.temperature)
        ? `${Math.round(period.temperature)}°`
        : '—'
    const iconUrl =
      typeof period.icon === 'string' && isUsableHttpUrl(period.icon.trim())
        ? period.icon.trim()
        : null
    const condition = compactForecastLabel(period.shortForecast ?? '')
    days.push({
      dayLabel: formatForecastDayLabel(period.startTime, period.name ?? ''),
      condition,
      icon: forecastIconKind(condition, iconUrl),
      high,
      rain: formatForecastPct(nwsQuantityValue(period.probabilityOfPrecipitation)),
      humidity: formatForecastPct(humidityForDaytimePeriod(period, hourly)),
    })
    if (days.length >= 3) break
  }
  return days
}

async function fetchNwsPointLabel(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`
  const res = await fetch(url, { signal, headers: NWS_FETCH_HEADERS })
  if (!res.ok) return null
  const data: unknown = await res.json()
  if (!data || typeof data !== 'object') return null
  const props = (data as { properties?: { relativeLocation?: unknown } }).properties
  const rel = props?.relativeLocation
  const relProps =
    rel && typeof rel === 'object'
      ? (rel as { properties?: { city?: unknown; state?: unknown } }).properties
      : undefined
  const city = typeof relProps?.city === 'string' ? relProps.city.trim() : ''
  const state = typeof relProps?.state === 'string' ? relProps.state.trim() : ''
  if (city && state) return `${city}, ${state}`
  if (city) return city
  return null
}

/** NOAA/NHC CurrentStorms.json — Vite proxy in dev, Vercel function in prod. */
const NHC_CURRENT_STORMS_URL = '/api/nhc-current-storms'

const NHC_FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'CoastCastVB/0.1 (Virginia Beach dashboard; educational use)',
} as const

type LivePhase = 'loading' | 'error' | 'ready'

type GeoCoords = { latitude: number; longitude: number }
type LocationSource = 'virginia-beach' | 'browser'
type GeoPhase = 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable' | 'timeout'

const VB_COORDS: GeoCoords = { latitude: VB_LAT, longitude: VB_LON }

function readUseMyLocationPref(): boolean {
  try {
    return window.localStorage.getItem(USE_MY_LOCATION_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function writeUseMyLocationPref(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(USE_MY_LOCATION_PREF_KEY, '1')
    else window.localStorage.removeItem(USE_MY_LOCATION_PREF_KEY)
  } catch {
    /* private mode / blocked storage */
  }
}

function readPrefFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writePrefFlag(key: string, enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    /* private mode / blocked storage */
  }
}

function readChoseVirginiaBeachPref(): boolean {
  return readPrefFlag(CHOSE_VB_PREF_KEY)
}

function writeChoseVirginiaBeachPref(enabled: boolean): void {
  writePrefFlag(CHOSE_VB_PREF_KEY, enabled)
}

function readLocationOnboardedPref(): boolean {
  return readPrefFlag(LOCATION_ONBOARDED_PREF_KEY)
}

function writeLocationOnboardedPref(enabled: boolean): void {
  writePrefFlag(LOCATION_ONBOARDED_PREF_KEY, enabled)
}

function isMobileLocationViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_LOC_MQ).matches
}

function shouldShowMobileLocationOnboard(): boolean {
  if (!isMobileLocationViewport()) return false
  if (readUseMyLocationPref() || readChoseVirginiaBeachPref() || readLocationOnboardedPref()) {
    return false
  }
  return true
}

function requestBrowserLocation(): Promise<GeoCoords> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject({ code: 2 })
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    )
  })
}

function geoPhaseFromError(err: unknown): GeoPhase {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? Number((err as { code: unknown }).code)
      : NaN
  return code === 1 ? 'denied' : code === 3 ? 'timeout' : 'unavailable'
}

async function geolocationPermissionState(): Promise<
  'granted' | 'denied' | 'prompt' | 'unknown'
> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
      return 'unknown'
    }
    const status = await navigator.permissions.query({ name: 'geolocation' })
    if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
      return status.state
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

type UsgsFeature = {
  properties: {
    mag: number | null
    place: string | null
    time: number | null
    url?: string
  }
}

type NwsAlertFeature = {
  id?: string
  properties?: {
    '@id'?: string | null
    event?: string | null
    headline?: string | null
    areaDesc?: string | null
  } | null
}

/** Prefer the GeoJSON feature URI, then properties.@id, only if it is http(s). */
function nwsAlertOfficialUrl(f: NwsAlertFeature): string | null {
  const candidates = [f.id, f.properties?.['@id']]
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const url = raw.trim()
    if (isUsableHttpUrl(url)) return url
  }
  return null
}


/**
 * NWS api.weather.gov does not ship marine zone text forecasts yet; this uses the
 * same official active-alerts feed as the NWS Alerts card (VB ocean point) and
 * keeps rows that look beach / surf / marine / coastal-flood related.
 */
function isMarineCoastalHazardAlert(f: NwsAlertFeature): boolean {
  const p = f.properties
  if (!p) return false
  const blob = `${p.event ?? ''} ${p.headline ?? ''} ${p.areaDesc ?? ''}`.toLowerCase()
  if (blob.includes('winter storm') || blob.includes('blizzard') || blob.includes('ice storm')) {
    return false
  }
  const needles = [
    'rip current',
    'beach hazards',
    'beach hazard',
    'coastal flood',
    'lakeshore flood',
    'high surf',
    'heavy surf',
    'small craft',
    'gale',
    'marine weather',
    'hazardous seas',
    'tsunami',
    'hurricane local',
    'storm surge',
    'tropical storm warning',
    'hurricane warning',
    'extreme wind',
  ]
  return needles.some((n) => blob.includes(n))
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function maxQuakeMag(quakes: UsgsFeature[]): number | null {
  let max: number | null = null
  for (const f of quakes) {
    const m = f.properties.mag
    if (m == null) continue
    if (max == null || m > max) max = m
  }
  return max
}

/** Stronger quakes add more points (USGS feed is already M2.5+). */
function quakeStressPoints(quakes: UsgsFeature[]): number {
  const max = maxQuakeMag(quakes)
  if (max == null) return 0
  return Math.round(clamp((max - 2.5) * 10, 0, 36))
}

/** More active alerts add more points (capped). */
function nwsStressPoints(alerts: NwsAlertFeature[]): number {
  return Math.min(44, alerts.length * 11)
}

/** Atlantic cyclones listed by NHC when that panel is ready; none / loading / error → 0. */
function hurricaneStressPoints(nhcPhase: LivePhase, storms: NhcStorm[]): number {
  if (nhcPhase !== 'ready') return 0
  if (storms.length === 0) return 0
  let pts = 0
  for (const s of storms) {
    const c = (s.classification ?? '').toUpperCase()
    if (c === 'HU') pts += 14
    else if (c === 'TS' || c === 'STS') pts += 10
    else pts += 7
  }
  return Math.min(30, pts)
}

/** Same NWS feed as the Marine card: coastal / rip / surf / small craft–style alerts. */
function marineStressPoints(nwsPhase: LivePhase, alerts: NwsAlertFeature[]): number {
  if (nwsPhase !== 'ready') return 0
  const n = alerts.filter(isMarineCoastalHazardAlert).length
  if (n === 0) return 0
  return Math.min(22, 6 + (n - 1) * 7)
}

function statusFromScore(score: number): 'Calm' | 'Guarded' | 'Elevated' | 'High' {
  if (score <= 22) return 'Calm'
  if (score <= 45) return 'Guarded'
  if (score <= 68) return 'Elevated'
  return 'High'
}

type ScoreResult = {
  score: number | null
  status: string
  blurb: string
}

/** Display-only threat band for the score numeral. Does not change the formula. */
function scoreToneClass(score: number | null): string {
  if (score == null) return 'score-summary__metric--pending'
  if (score <= 19) return 'score-summary__metric--t0'
  if (score <= 39) return 'score-summary__metric--t1'
  if (score <= 59) return 'score-summary__metric--t2'
  if (score <= 79) return 'score-summary__metric--t3'
  return 'score-summary__metric--t4'
}

/**
 * Live USGS quakes + NWS active-location alerts + NHC Atlantic list + marine-style
 * alert subset — 0–100 score, status label, short blurb. Forecast / Skywatch are not scored.
 */
function computeVbScore(input: {
  quakePhase: LivePhase
  nwsPhase: LivePhase
  nhcPhase: LivePhase
  quakes: UsgsFeature[]
  alerts: NwsAlertFeature[]
  atlanticStorms: NhcStorm[]
  locationName: string
}): ScoreResult {
  const { quakePhase, nwsPhase, nhcPhase, quakes, alerts, atlanticStorms, locationName } =
    input

  if (quakePhase === 'loading' || nwsPhase === 'loading') {
    return {
      score: null,
      status: 'Loading',
      blurb: 'Checking latest conditions…',
    }
  }

  const qPts = quakePhase === 'ready' ? quakeStressPoints(quakes) : 0
  const nPts = nwsPhase === 'ready' ? nwsStressPoints(alerts) : 0
  const hPts = hurricaneStressPoints(nhcPhase, atlanticStorms)
  const mPts = marineStressPoints(nwsPhase, alerts)

  const raw = qPts + nPts + hPts + mPts
  const score = clamp(Math.round(raw), 0, 100)
  const status = statusFromScore(score)

  const quakesQuiet = quakePhase === 'ready' && quakes.length === 0
  const alertsClear = nwsPhase === 'ready' && alerts.length === 0
  const atlanticClear = nhcPhase === 'ready' && atlanticStorms.length === 0

  let blurb: string
  if (quakesQuiet && alertsClear && atlanticClear) {
    blurb =
      'Quiet overall — no nearby quakes, no active weather alerts, and no Atlantic tropical systems.'
  } else {
    const bits: string[] = []
    if (quakePhase === 'error') bits.push('earthquake data unavailable')
    else if (quakes.length > 0) {
      const m = maxQuakeMag(quakes)
      bits.push(
        m != null ? `strongest nearby quake about M ${m.toFixed(1)}` : 'nearby quake activity',
      )
    } else if (quakesQuiet) {
      bits.push('no nearby quakes')
    }

    if (nwsPhase === 'error') bits.push('weather alerts unavailable')
    else if (alerts.length > 0) {
      bits.push(
        `${alerts.length} active weather alert${alerts.length === 1 ? '' : 's'}`,
      )
    } else if (alertsClear) {
      bits.push('no active weather alerts')
    }

    if (nhcPhase === 'loading') bits.push('checking tropical systems')
    else if (nhcPhase === 'error') bits.push('tropical system data unavailable')
    else if (atlanticStorms.length > 0) {
      bits.push(
        `${atlanticStorms.length} Atlantic tropical system${atlanticStorms.length === 1 ? '' : 's'}`,
      )
    } else if (atlanticClear) {
      bits.push('no Atlantic tropical systems')
    }

    blurb = bits.length > 0 ? `${bits.join(', ')}.` : `Conditions around ${locationName}.`
  }

  return { score, status, blurb }
}

const metaMuted: React.CSSProperties = {
  marginTop: '0.65rem',
  fontSize: '0.75rem',
  color: 'rgba(200, 210, 225, 0.55)',
  lineHeight: 1.4,
}

function formatUpdatedFooter(source: string, fetchedAt: Date | null): string {
  if (fetchedAt == null || Number.isNaN(fetchedAt.getTime())) {
    return `UPDATED · ${source} · —`
  }
  const datePart = fetchedAt
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .replace(/\./g, '')
    .toUpperCase()
  const timePart = fetchedAt
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(/\u202f/g, '\u00A0')
    .replace(/ /g, '\u00A0')
  return `UPDATED · ${source} · ${datePart} · ${timePart}`
}

const USNO_ONEDAY_URL = '/api/usno-oneday'

type SkywatchSunMoon = {
  sunrise: string | null
  sunset: string | null
  moonPhase: string | null
  illumination: string | null
}

type NasaSkyEvent = {
  date: string
  title: string
  note: string
  url: string
}

/** Curated 2026 events from official NASA Science skywatching pages. */
const NASA_SKY_EVENTS: NasaSkyEvent[] = [
  {
    date: '2026-09-14',
    title: 'Moon near Antares and the Teapot',
    note: 'Look south about an hour after sunset.',
    url: 'https://science.nasa.gov/skywatching/whats-up/whats-up-september-2026-skywatching-tips-from-nasa/',
  },
  {
    date: '2026-09-18',
    title: 'Venus at peak brilliance',
    note: 'Look west shortly after sunset.',
    url: 'https://science.nasa.gov/skywatching/whats-up/whats-up-september-2026-skywatching-tips-from-nasa/',
  },
  {
    date: '2026-09-22',
    title: 'September equinox',
    note: 'Fall begins in the Northern Hemisphere.',
    url: 'https://science.nasa.gov/skywatching/whats-up/whats-up-september-2026-skywatching-tips-from-nasa/',
  },
  {
    date: '2026-09-26',
    title: 'Harvest Moon near Saturn and Neptune',
    note: 'Rises in the east shortly after sunset.',
    url: 'https://science.nasa.gov/skywatching/whats-up/whats-up-september-2026-skywatching-tips-from-nasa/',
  },
  {
    date: '2026-10-21',
    title: 'Orionid meteor shower peak',
    note: 'Best after midnight under dark skies.',
    url: 'https://science.nasa.gov/solar-system/meteors-meteorites/orionids/',
  },
]

function nextNasaSkyEvent(localYmd: string): NasaSkyEvent | null {
  const upcoming = NASA_SKY_EVENTS.filter((e) => e.date >= localYmd)
  return upcoming[0] ?? null
}

function localYmdInTimeZone(timeZone: string, now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone })
}

function utcOffsetHours(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(
    dtf
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return (asUtc - at.getTime()) / 3_600_000
}

function formatUsnoTz(hours: number): string {
  const stepped = Math.round(hours * 4) / 4
  return Number.isInteger(stepped) ? String(stepped) : stepped.toFixed(2)
}

function lonGuessOffsetHours(lon: number): number {
  return Math.max(-12, Math.min(14, Math.round(lon / 15)))
}

function formatUsnoClock(raw: string | null | undefined): string | null {
  if (!raw || raw === 'null') return null
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2]
  if (!Number.isFinite(hour)) return null
  const ap = hour >= 12 ? 'PM' : 'AM'
  hour = hour % 12
  if (hour === 0) hour = 12
  return `${hour}:${minute}\u00A0${ap}`
}

function formatIllumination(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const pct = raw <= 1 ? raw * 100 : raw
    return `${Math.round(pct)}%`
  }
  if (typeof raw !== 'string') return null
  const m = raw.replace(',', '.').match(/(\d+(?:\.\d+)?)/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const pct = n <= 1 && !raw.includes('%') ? n * 100 : n
  return `${Math.round(pct)}%`
}

async function fetchNwsTimeZone(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(nwsPointsUrl(lat, lon), {
    signal,
    headers: NWS_FETCH_HEADERS,
  })
  if (!res.ok) return null
  const data: unknown = await res.json()
  const zone =
    data && typeof data === 'object'
      ? (data as { properties?: { timeZone?: unknown } }).properties?.timeZone
      : undefined
  return typeof zone === 'string' && zone.trim() ? zone.trim() : null
}

function parseUsnoOneday(data: unknown): SkywatchSunMoon {
  if (data && typeof data === 'object' && 'error' in data) {
    const err = (data as { error?: unknown }).error
    if (err) throw new Error(typeof err === 'string' ? err : 'USNO returned an error')
  }
  const raw =
    data && typeof data === 'object'
      ? (data as { properties?: { data?: unknown } }).properties?.data
      : undefined
  if (!raw || typeof raw !== 'object') {
    throw new Error('USNO returned no sun/moon data')
  }
  const d = raw as {
    curphase?: unknown
    fracillum?: unknown
    sundata?: unknown
  }
  const sundata = Array.isArray(d.sundata)
    ? (d.sundata as { phen?: unknown; time?: unknown }[])
    : []
  const rise = sundata.find((x) => String(x.phen ?? '').toLowerCase() === 'rise')
  const set = sundata.find((x) => String(x.phen ?? '').toLowerCase() === 'set')
  const phase = typeof d.curphase === 'string' ? d.curphase.trim() : ''
  return {
    sunrise: formatUsnoClock(typeof rise?.time === 'string' ? rise.time : null),
    sunset: formatUsnoClock(typeof set?.time === 'string' ? set.time : null),
    moonPhase: phase || null,
    illumination: formatIllumination(d.fracillum),
  }
}

const badgeBase: React.CSSProperties = {
  flexShrink: 0,
  fontSize: '0.65rem',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '0.25rem 0.55rem',
  borderRadius: '999px',
  border: '1px solid rgba(255, 255, 255, 0.14)',
}

const panelHead: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: '0.6rem',
  marginBottom: '0.15rem',
}

const quakeLine: React.CSSProperties = {
  margin: '0.45rem 0 0',
  fontSize: '0.90625rem',
  lineHeight: 1.55,
}

type WindyLayer = 'radar' | 'wind' | 'rain'

const VB_WINDY_LAT = '36.8529'
const VB_WINDY_LON = '-75.9780'

function windyEmbedUrl(overlay: WindyLayer, lat: string, lon: string): string {
  const product = overlay === 'radar' ? 'radar' : 'ecmwf'
  const q = new URLSearchParams({
    lat,
    lon,
    detailLat: lat,
    detailLon: lon,
    zoom: '9',
    level: 'surface',
    overlay,
    product,
    type: 'map',
    location: 'coordinates',
    calendar: 'now',
    metricWind: 'default',
    metricTemp: 'default',
    radarRange: '-1',
  })
  return `https://embed.windy.com/embed2.html?${q.toString()}&menu=&message=&marker=&pressure=&detail=`
}

function WindyMapCard(props: {
  latitude: number
  longitude: number
  usingCurrentLocation: boolean
  placeLabel: string | null
}) {
  const { latitude, longitude, usingCurrentLocation, placeLabel } = props
  const [layer, setLayer] = useState<WindyLayer>('radar')
  const layers: { id: WindyLayer; label: string }[] = [
    { id: 'radar', label: 'RADAR' },
    { id: 'wind', label: 'WIND' },
    { id: 'rain', label: 'RAIN' },
  ]

  const latStr = usingCurrentLocation ? latitude.toFixed(4) : VB_WINDY_LAT
  const lonStr = usingCurrentLocation ? longitude.toFixed(4) : VB_WINDY_LON
  const locationLabel = usingCurrentLocation
    ? (placeLabel ?? 'Current location')
    : 'Virginia Beach / Norfolk'

  return (
    <section className="card map-placeholder" aria-label="Map area">
      <h2 className="card__title">Map</h2>
      <div className="map-card-controls">
        <div className="map-layer-select" role="group" aria-label="Map layer">
          {layers.map((item, i) => (
            <span key={item.id} className="map-layer-select__item">
              {i > 0 && (
                <span className="map-layer-select__sep" aria-hidden="true">
                  |
                </span>
              )}
              <button
                type="button"
                className={layer === item.id ? 'is-active' : undefined}
                aria-pressed={layer === item.id}
                onClick={() => setLayer(item.id)}
              >
                {item.label}
              </button>
            </span>
          ))}
        </div>
        <p className="map-placeholder__loc">{locationLabel}</p>
      </div>
      <div className="map-placeholder__frame map-placeholder__frame--live">
        <iframe
          key={`${latStr},${lonStr}`}
          className="map-placeholder__iframe"
          title={`Windy ${layer} map of ${locationLabel}`}
          src={windyEmbedUrl(layer, latStr, lonStr)}
          loading="lazy"
        />
      </div>
    </section>
  )
}

function quakeRadiusPhrase(usingCurrentLocation: boolean, placeLabel: string | null): string {
  if (!usingCurrentLocation) return 'within 500 miles of Virginia Beach'
  if (placeLabel) return `within 500 miles of ${placeLabel}`
  return 'within 500 miles of your location'
}

function QuakesCard(props: {
  phase: LivePhase
  items: UsgsFeature[]
  errorMessage: string
  fetchedAt: Date | null
  usingCurrentLocation: boolean
  placeLabel: string | null
}) {
  const { phase, items, errorMessage, fetchedAt, usingCurrentLocation, placeLabel } = props
  const shown = items.slice(0, 3)
  const radiusPhrase = quakeRadiusPhrase(usingCurrentLocation, placeLabel)

  let badge: { label: string; style: React.CSSProperties }
  if (phase === 'loading') {
    badge = {
      label: '···',
      style: {
        ...badgeBase,
        background: 'rgba(200, 200, 210, 0.08)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        color: 'rgba(200, 210, 225, 0.75)',
      },
    }
  } else if (phase === 'error') {
    badge = {
      label: 'Issue',
      style: {
        ...badgeBase,
        background: 'rgba(240, 120, 120, 0.12)',
        borderColor: 'rgba(240, 140, 140, 0.4)',
        color: 'rgba(255, 190, 190, 0.95)',
      },
    }
  } else if (shown.length === 0) {
    badge = {
      label: 'Quiet',
      style: {
        ...badgeBase,
        background: 'rgba(120, 200, 160, 0.12)',
        borderColor: 'rgba(120, 200, 160, 0.35)',
        color: 'rgba(180, 235, 205, 0.95)',
      },
    }
  } else {
    badge = {
      label: 'Live',
      style: {
        ...badgeBase,
        background: 'rgba(120, 200, 160, 0.12)',
        borderColor: 'rgba(120, 200, 160, 0.35)',
        color: 'rgba(180, 235, 205, 0.95)',
      },
    }
  }

  return (
    <section className="card panel">
      <div style={panelHead}>
        <h2 className="card__title">Quakes</h2>
        <span style={badge.style}>{badge.label}</span>
      </div>

      {phase === 'loading' && (
        <p className="panel__body">Loading recent quakes from USGS…</p>
      )}

      {phase === 'error' && (
        <p className="panel__body">
          Could not reach USGS right now ({errorMessage}). Try refreshing in a bit.
        </p>
      )}

      {phase === 'ready' && shown.length === 0 && (
        <p className="panel__body">
          No recent earthquakes showed up {radiusPhrase} — the
          coast is seismically quiet for now.
        </p>
      )}

      {phase === 'ready' && shown.length > 0 && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>
            Latest from USGS ({radiusPhrase}, M2.5+):
          </p>
          {shown.map((f, i) => {
            const m = f.properties.mag!
            const place = f.properties.place!
            const when = new Date(f.properties.time!).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })
            return (
              <p key={`${f.properties.time}-${i}`} style={{ ...quakeLine, marginTop: i === 0 ? '0.5rem' : '0.45rem' }}>
                <strong>M {m.toFixed(1)}</strong>
                {' · '}
                {place}
                {' · '}
                {when}
              </p>
            )
          })}
        </div>
      )}

      <p className="card-footer">{formatUpdatedFooter('USGS', fetchedAt)}</p>
    </section>
  )
}

function NwsAlertsCard(props: {
  phase: LivePhase
  alerts: NwsAlertFeature[]
  errorMessage: string
  fetchedAt: Date | null
}) {
  const { phase, alerts, errorMessage, fetchedAt } = props
  const shown = alerts.slice(0, 5)

  let badge: { label: string; style: React.CSSProperties }
  if (phase === 'loading') {
    badge = {
      label: '···',
      style: {
        ...badgeBase,
        background: 'rgba(200, 200, 210, 0.08)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        color: 'rgba(200, 210, 225, 0.75)',
      },
    }
  } else if (phase === 'error') {
    badge = {
      label: 'Issue',
      style: {
        ...badgeBase,
        background: 'rgba(240, 120, 120, 0.12)',
        borderColor: 'rgba(240, 140, 140, 0.4)',
        color: 'rgba(255, 190, 190, 0.95)',
      },
    }
  } else if (shown.length === 0) {
    badge = {
      label: 'None',
      style: {
        ...badgeBase,
        background: 'rgba(200, 200, 210, 0.08)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        color: 'rgba(210, 218, 230, 0.9)',
      },
    }
  } else {
    badge = {
      label: 'Active',
      style: {
        ...badgeBase,
        background: 'rgba(240, 190, 110, 0.12)',
        borderColor: 'rgba(240, 190, 110, 0.35)',
        color: 'rgba(255, 220, 160, 0.95)',
      },
    }
  }

  return (
    <section className="card panel nws-alerts-card">
      <div style={panelHead}>
        <h2 className="card__title">Weather Alerts</h2>
        <span style={badge.style}>{badge.label}</span>
      </div>

      {phase === 'loading' && (
        <p className="panel__body">Loading active alerts from weather.gov…</p>
      )}

      {phase === 'error' && (
        <p className="panel__body">
          Could not load alerts from weather.gov ({errorMessage}). Try refreshing in
          a little while.
        </p>
      )}

      {phase === 'ready' && shown.length === 0 && (
        <p className="panel__body">
          No active weather alerts for the Virginia Beach point right now — a
          calm day on the official feed.
        </p>
      )}

      {phase === 'ready' && shown.length > 0 && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>
            Active alerts affecting Virginia Beach, VA (NWS point lookup):
          </p>
          {shown.map((f, i) => {
            const p = f.properties!
            const event = (p.event && p.event.trim()) || 'Alert'
            const line =
              (p.headline && p.headline.trim()) ||
              (p.areaDesc && `Applies to: ${p.areaDesc}`) ||
              'See weather.gov for details.'
            const officialUrl = nwsAlertOfficialUrl(f)
            return (
              <p
                key={f.id ?? `${event}-${i}`}
                style={{ ...quakeLine, marginTop: i === 0 ? '0.5rem' : '0.45rem' }}
              >
                {officialUrl ? (
                  <a
                    href={officialUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <strong>{event}</strong>
                    <span className="nws-alert-ext" aria-hidden="true">
                      {' '}
                      ↗
                    </span>
                  </a>
                ) : (
                  <strong>{event}</strong>
                )}
                {' — '}
                {line}
              </p>
            )
          })}
        </div>
      )}

      <p className="card-footer">{formatUpdatedFooter('NWS', fetchedAt)}</p>
    </section>
  )
}

function compactAtlanticTrend(trend: HurricaneTrend): string {
  if (trend === 'Approaching') return 'approaching'
  if (trend === 'Moving away') return 'moving away'
  return 'uncertain'
}

function hurricaneBadge(label: string, phase: LivePhase): React.CSSProperties {
  if (phase === 'loading') {
    return {
      ...badgeBase,
      background: 'rgba(200, 200, 210, 0.08)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      color: 'rgba(200, 210, 225, 0.75)',
    }
  }
  if (phase === 'error') {
    return {
      ...badgeBase,
      background: 'rgba(240, 120, 120, 0.12)',
      borderColor: 'rgba(240, 140, 140, 0.4)',
      color: 'rgba(255, 190, 190, 0.95)',
    }
  }
  if (label === 'HIGH' || label === 'ELEVATED') {
    return {
      ...badgeBase,
      background: 'rgba(240, 190, 110, 0.12)',
      borderColor: 'rgba(240, 190, 110, 0.35)',
      color: 'rgba(255, 220, 160, 0.95)',
    }
  }
  return {
    ...badgeBase,
    background: 'rgba(120, 190, 255, 0.1)',
    borderColor: 'rgba(120, 190, 255, 0.3)',
    color: 'rgba(170, 215, 255, 0.95)',
  }
}

function HurricanesCard(props: {
  phase: LivePhase
  storms: NhcStorm[]
  errorMessage: string
  fetchedAt: Date | null
  latitude: number
  longitude: number
  usingCurrentLocation: boolean
  placeLabel: string | null
  weatherAlerts: NwsAlertFeature[]
  weatherAlertPhase: LivePhase
}) {
  const {
    phase,
    storms,
    errorMessage,
    fetchedAt,
    latitude,
    longitude,
    usingCurrentLocation,
    placeLabel,
    weatherAlerts,
    weatherAlertPhase,
  } = props

  const [productsById, setProductsById] = useState<Record<string, NhcStormProducts>>({})
  const stormKey = storms
    .map((s) => {
      const adv =
        s.forecastAdvisory?.advNum ??
        s.forecastTrack?.advNum ??
        s.lastUpdate ??
        ''
      return `${s.id ?? s.name ?? ''}:${adv}`
    })
    .join('|')

  useEffect(() => {
    if (phase !== 'ready' || storms.length === 0) {
      setProductsById({})
      return
    }
    const ctrl = new AbortController()
    ;(async () => {
      const entries = await Promise.all(
        storms.map(async (storm, i) => {
          const id = storm.id ?? storm.name ?? `storm-${i}`
          try {
            return [id, await loadStormProducts(storm, ctrl.signal)] as const
          } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return null
            return [id, undefined] as const
          }
        }),
      )
      if (ctrl.signal.aborted) return
      const next: Record<string, NhcStormProducts> = {}
      for (const row of entries) {
        if (!row || !row[1]) continue
        next[row[0]] = row[1]
      }
      setProductsById(next)
    })()
    return () => ctrl.abort()
  }, [phase, stormKey, storms])

  const location = useMemo(
    () => ({ lat: latitude, lon: longitude }),
    [latitude, longitude],
  )
  const nwsWw =
    weatherAlertPhase === 'ready' ? tropicalWatchWarningFromAlerts(weatherAlerts) : null
  const evals = useMemo(() => {
    const rows: HurricaneEval[] = storms.map((storm, i) => {
      const id = storm.id ?? storm.name ?? `storm-${i}`
      return evaluateStorm(storm, location, productsById[id], nwsWw)
    })
    rows.sort(compareEvals)
    return rows
  }, [storms, location, productsById, nwsWw])

  const primary = evals[0] ?? null
  const extras = evals.slice(1)
  const relevanceLabel: HurricaneRelevance | 'Issue' | '···' =
    phase === 'loading' ? '···' : phase === 'error' ? 'Issue' : (primary?.relevance ?? 'CLEAR')
  const place = relevancePlacePhrase(usingCurrentLocation, placeLabel)

  return (
    <section className="card panel hurricanes-card">
      <div style={panelHead}>
        <h2 className="card__title">Hurricanes</h2>
        <span style={hurricaneBadge(relevanceLabel, phase)}>{relevanceLabel}</span>
      </div>

      {phase === 'loading' && (
        <p className="panel__body">Loading Atlantic storm status from NOAA/NHC…</p>
      )}

      {phase === 'error' && (
        <p className="panel__body">
          Could not load NHC data ({errorMessage}). If the browser blocked the
          request, try again later — this feed is the official CurrentStorms.json
          file.
        </p>
      )}

      {phase === 'ready' && !primary && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>No active Atlantic tropical systems right now.</p>
          <p style={metaMuted}>NHC Atlantic basin</p>
        </div>
      )}

      {phase === 'ready' && primary && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>
            <strong>{primary.headline}</strong>
          </p>
          <p className="hurricane-relevance">Relevance to {place}</p>
          <dl className="hurricane-stats">
            <div className="hurricane-stats__row">
              <dt>Current distance</dt>
              <dd>{formatMiles(primary.currentMiles)}</dd>
            </div>
            <div className="hurricane-stats__row">
              <dt>Closest forecast</dt>
              <dd>{formatMiles(primary.closestForecastMiles)}</dd>
            </div>
            <div className="hurricane-stats__row">
              <dt>Official cone</dt>
              <dd>{primary.cone}</dd>
            </div>
            <div className="hurricane-stats__row">
              <dt>Watch / warning</dt>
              <dd>{primary.watchWarning}</dd>
            </div>
            <div className="hurricane-stats__row">
              <dt>Trend</dt>
              <dd>{primary.trend}</dd>
            </div>
          </dl>
          {primary.officialUrl ? (
            <p className="hurricane-link">
              <a
                href={primary.officialUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                NHC forecast
                <span className="nhc-forecast-ext" aria-hidden="true">
                  {' '}
                  ↗
                </span>
              </a>
            </p>
          ) : null}
          <p style={metaMuted}>
            Based on official NHC forecast data — CoastCast does not predict storm
            paths.
          </p>
          {extras.length > 0 ? (
            <div className="hurricane-others">
              <p className="hurricane-others__label">OTHER ATLANTIC SYSTEMS</p>
              {extras.map((row, i) => {
                const bits: string[] = [row.relevance]
                if (row.closestForecastMiles != null) {
                  bits.push(`${Math.round(row.closestForecastMiles)} mi`)
                }
                bits.push(compactAtlanticTrend(row.trend))
                return (
                  <div
                    key={row.storm.id ?? `${row.headline}-${i}`}
                    className="hurricane-others__item"
                  >
                    <p className="hurricane-others__name">
                      <strong>{row.headline}</strong>
                    </p>
                    <p className="hurricane-others__meta">
                      {bits.join(' · ')}
                      {row.officialUrl ? (
                        <>
                          {' · '}
                          <a
                            href={row.officialUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            NHC forecast
                            <span className="nhc-forecast-ext" aria-hidden="true">
                              {' '}
                              ↗
                            </span>
                          </a>
                        </>
                      ) : null}
                    </p>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      )}

      <p className="card-footer">{formatUpdatedFooter('NHC', fetchedAt)}</p>
    </section>
  )
}

function ForecastGlyph(props: { kind: ForecastIconKind }) {
  const { kind } = props
  return (
    <svg className="forecast__icon" viewBox="0 0 24 24" aria-hidden="true">
      {kind === 'sun' && (
        <>
          <circle cx="12" cy="12" r="5" fill="#fbbf24" />
          <g stroke="#f59e0b" strokeWidth="1.7" strokeLinecap="round" fill="none">
            <path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.2 5.2l1.5 1.5M17.3 17.3l1.5 1.5M5.2 18.8l1.5-1.5M17.3 6.7l1.5-1.5" />
          </g>
        </>
      )}
      {kind === 'mostly-sun' && (
        <>
          <circle cx="9.2" cy="9.2" r="4.1" fill="#fbbf24" />
          <g stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" fill="none">
            <path d="M9.2 2.4v1.7M2.4 9.2h1.7M4.2 4.2l1.2 1.2M14.2 4.2l-1.2 1.2" />
          </g>
          <path
            fill="#e2e8f0"
            d="M8.2 18.6h9.4a3.4 3.4 0 0 0 .3-6.8 4.4 4.4 0 0 0-8.4-1.3 3.5 3.5 0 0 0-1.3 8.1z"
          />
        </>
      )}
      {kind === 'partly-cloud' && (
        <>
          <circle cx="8.4" cy="8.6" r="4" fill="#fbbf24" />
          <path
            fill="#cbd5e1"
            d="M7.6 19h10.2a3.6 3.6 0 0 0 .2-7.2 4.6 4.6 0 0 0-8.8-1.2A3.6 3.6 0 0 0 7.6 19z"
          />
        </>
      )}
      {kind === 'cloud' && (
        <path
          fill="#94a3b8"
          d="M6.2 18.6h11.3a3.7 3.7 0 0 0 .3-7.4 5 5 0 0 0-9.6-1.5 3.9 3.9 0 0 0-2 8.9z"
        />
      )}
      {(kind === 'showers' || kind === 'rain') && (
        <>
          <path
            fill="#94a3b8"
            d="M6.4 13.8h11a3.5 3.5 0 0 0 .3-7 4.7 4.7 0 0 0-9.1-1.4 3.7 3.7 0 0 0-2.2 8.4z"
          />
          <g stroke="#38bdf8" strokeWidth="1.7" strokeLinecap="round">
            <path d="M8.2 16.4v2.6M12 17.1v2.8M15.8 16.4v2.6" />
          </g>
        </>
      )}
      {kind === 'storm' && (
        <>
          <path
            fill="#64748b"
            d="M6.2 13.4h11.2a3.5 3.5 0 0 0 .2-7 4.8 4.8 0 0 0-9.3-1.3A3.7 3.7 0 0 0 6.2 13.4z"
          />
          <path fill="#fbbf24" d="M12.7 12.6 9.4 18.2h2.3l-1 4.2 4.4-6.4h-2.5z" />
        </>
      )}
      {kind === 'snow' && (
        <>
          <path
            fill="#94a3b8"
            d="M6.4 13.6h11a3.5 3.5 0 0 0 .3-7 4.7 4.7 0 0 0-9.1-1.4 3.7 3.7 0 0 0-2.2 8.4z"
          />
          <g fill="#e2e8f0">
            <circle cx="8.4" cy="17.4" r="1" />
            <circle cx="12" cy="18.6" r="1" />
            <circle cx="15.6" cy="17.4" r="1" />
          </g>
        </>
      )}
      {kind === 'fog' && (
        <g stroke="#94a3b8" strokeWidth="1.8" strokeLinecap="round">
          <path d="M4.4 8.2h15.2M5.2 12h13.6M4.8 15.8h14.4M6.2 19.2h11.6" />
        </g>
      )}
      {kind === 'wind' && (
        <g stroke="#7dd3fc" strokeWidth="1.8" strokeLinecap="round" fill="none">
          <path d="M3.6 9.2h11.4a2.4 2.4 0 1 0-2.4-2.4" />
          <path d="M3.6 13.2h14.2a2.5 2.5 0 1 1-2.5 2.5" />
          <path d="M3.6 17.4h8.8" />
        </g>
      )}
    </svg>
  )
}

function ForecastCard(props: {
  phase: LivePhase
  days: ForecastDay[]
  errorMessage: string
  fetchedAt: Date | null
}) {
  const { phase, days, errorMessage, fetchedAt } = props

  let badge: { label: string; style: React.CSSProperties }
  if (phase === 'loading') {
    badge = {
      label: '···',
      style: {
        ...badgeBase,
        background: 'rgba(200, 200, 210, 0.08)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        color: 'rgba(200, 210, 225, 0.75)',
      },
    }
  } else if (phase === 'error') {
    badge = {
      label: 'Issue',
      style: {
        ...badgeBase,
        background: 'rgba(240, 120, 120, 0.12)',
        borderColor: 'rgba(240, 140, 140, 0.4)',
        color: 'rgba(255, 190, 190, 0.95)',
      },
    }
  } else if (days.length === 0) {
    badge = {
      label: 'None',
      style: {
        ...badgeBase,
        background: 'rgba(200, 200, 210, 0.08)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        color: 'rgba(200, 210, 225, 0.75)',
      },
    }
  } else {
    badge = {
      label: 'Live',
      style: {
        ...badgeBase,
        background: 'rgba(120, 200, 160, 0.12)',
        borderColor: 'rgba(120, 200, 160, 0.35)',
        color: 'rgba(180, 235, 205, 0.95)',
      },
    }
  }

  return (
    <section className="card panel panel--nature">
      <div style={panelHead}>
        <h2 className="card__title">3-Day Forecast</h2>
        <span style={badge.style}>{badge.label}</span>
      </div>

      {phase === 'loading' && (
        <p className="panel__body">Loading 3-day forecast…</p>
      )}

      {phase === 'error' && (
        <p className="panel__body">
          Could not load the NWS forecast
          {errorMessage ? ` (${errorMessage})` : ''}.
        </p>
      )}

      {phase === 'ready' && days.length === 0 && (
        <p className="panel__body">No daytime forecast periods available right now.</p>
      )}

      {phase === 'ready' && days.length > 0 && (
        <div className="panel__body forecast">
          {days.map((day, i) => (
            <div key={`${day.dayLabel}-${i}`} className="forecast__day">
              <p className="forecast__dow">{day.dayLabel}</p>
              <div className="forecast__main">
                <div className="forecast__copy">
                  <p className="forecast__cond">
                    <ForecastGlyph kind={day.icon} />
                    <span>{day.condition}</span>
                  </p>
                  <p className="forecast__meta">
                    Rain {day.rain} · Humidity {day.humidity}
                  </p>
                </div>
                <p className="forecast__temp">{day.high}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="card-footer">{formatUpdatedFooter('NWS', fetchedAt)}</p>
    </section>
  )
}

function SkywatchCard(props: {
  phase: LivePhase
  sunMoon: SkywatchSunMoon | null
  nextEvent: NasaSkyEvent | null
  errorMessage: string
  fetchedAt: Date | null
}) {
  const { phase, sunMoon, nextEvent, errorMessage, fetchedAt } = props

  let badge: { label: string; style: React.CSSProperties }
  if (phase === 'loading') {
    badge = {
      label: '···',
      style: {
        ...badgeBase,
        background: 'rgba(129, 140, 248, 0.08)',
        borderColor: 'rgba(129, 140, 248, 0.28)',
        color: 'rgba(196, 181, 253, 0.75)',
      },
    }
  } else if (phase === 'error') {
    badge = {
      label: 'Issue',
      style: {
        ...badgeBase,
        background: 'rgba(240, 120, 120, 0.12)',
        borderColor: 'rgba(240, 140, 140, 0.4)',
        color: 'rgba(255, 190, 190, 0.95)',
      },
    }
  } else {
    badge = {
      label: 'Live',
      style: {
        ...badgeBase,
        background: 'rgba(129, 140, 248, 0.1)',
        borderColor: 'rgba(129, 140, 248, 0.35)',
        color: 'rgba(196, 181, 253, 0.95)',
      },
    }
  }

  const sunrise = sunMoon?.sunrise ?? '—'
  const sunset = sunMoon?.sunset ?? '—'
  const moonLine =
    sunMoon?.moonPhase && sunMoon.illumination
      ? `${sunMoon.moonPhase} · ${sunMoon.illumination}`
      : sunMoon?.moonPhase
        ? sunMoon.moonPhase
        : sunMoon?.illumination
          ? sunMoon.illumination
          : '—'

  const eventTitle = nextEvent?.title ?? 'NASA skywatching tips'
  const eventUrl = nextEvent?.url ?? 'https://science.nasa.gov/skywatching/whats-up/'
  const eventNote = nextEvent?.note ?? 'Official monthly skywatching highlights from NASA.'

  return (
    <section className="card panel skywatch-card">
      <div style={panelHead}>
        <h2 className="card__title">Skywatch</h2>
        <span style={badge.style}>{badge.label}</span>
      </div>

      {phase === 'loading' && (
        <p className="panel__body">Loading sun and moon times from USNO…</p>
      )}

      {phase === 'error' && (
        <p className="panel__body">
          Could not load sun and moon times from the U.S. Naval Observatory
          {errorMessage ? ` (${errorMessage})` : ''}.
        </p>
      )}

      {phase === 'ready' && (
        <div className="panel__body skywatch">
          <p className="skywatch__sunline">
            <span>
              <span className="skywatch__k">Sunrise</span> {sunrise}
            </span>
            <span className="skywatch__pipe" aria-hidden="true">
              |
            </span>
            <span>
              <span className="skywatch__k">Sunset</span> {sunset}
            </span>
          </p>
          <div className="skywatch__row">
            <span>Moon</span>
            <span>{moonLine}</span>
          </div>
          <p className="skywatch__next-label">Next up</p>
          <p className="skywatch__event">
            <a
              className="skywatch__event-link"
              href={eventUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {eventTitle}
              <span className="skywatch__ext" aria-hidden="true">
                {' '}
                ↗
              </span>
            </a>
          </p>
          <p className="skywatch__hint">{eventNote}</p>
        </div>
      )}

      <p className="card-footer">{formatUpdatedFooter('USNO / NASA', fetchedAt)}</p>
    </section>
  )
}

function scoreStatusHeadline(score: number | null): { label: string; summary: string } {
  if (score == null) return { label: 'LOADING', summary: 'Checking latest conditions' }
  if (score <= 19) return { label: 'CALM', summary: 'No immediate local threats' }
  if (score <= 39) return { label: 'GUARDED', summary: 'A few conditions to watch' }
  if (score <= 59) return { label: 'ELEVATED', summary: 'Conditions need attention' }
  if (score <= 79) return { label: 'HIGH', summary: 'Active hazards nearby' }
  return { label: 'SEVERE', summary: 'Take action on active warnings' }
}

function nwsTickerAlerts(alerts: NwsAlertFeature[]): string[] {
  const events: string[] = []
  for (const alert of alerts) {
    const event = (alert.properties?.event ?? '').trim()
    if (event && !events.includes(event)) events.push(event)
  }
  if (events.length === 0) {
    return [
      `${alerts.length} active weather alert${alerts.length === 1 ? '' : 's'}`,
    ]
  }
  if (events.length <= 3) return events
  return [...events.slice(0, 2), `${alerts.length} active weather alerts`]
}

function buildScoreTickerItems(input: {
  quakePhase: LivePhase
  nwsPhase: LivePhase
  nhcPhase: LivePhase
  quakes: UsgsFeature[]
  alerts: NwsAlertFeature[]
  atlanticStorms: NhcStorm[]
}): string[] {
  const { quakePhase, nwsPhase, nhcPhase, quakes, alerts, atlanticStorms } = input
  if (quakePhase === 'loading' || nwsPhase === 'loading') {
    return ['Checking latest conditions']
  }

  const important: string[] = []
  const info: string[] = []

  if (nwsPhase === 'error') important.push('Weather alerts unavailable')
  else if (alerts.length > 0) important.push(...nwsTickerAlerts(alerts))
  else info.push('No active weather alerts')

  if (nhcPhase === 'error') important.push('Tropical system data unavailable')
  else if (nhcPhase === 'loading') info.push('Checking tropical systems')
  else if (atlanticStorms.length === 1) {
    important.push(stormHeadline(atlanticStorms[0]))
  } else if (atlanticStorms.length > 1) {
    important.push(
      `${atlanticStorms.length} Atlantic tropical systems`,
    )
  } else {
    info.push('No Atlantic tropical systems')
  }

  if (quakePhase === 'error') important.push('Earthquake data unavailable')
  else if (quakes.length > 0) {
    const mag = maxQuakeMag(quakes)
    important.push(
      mag != null
        ? `Strongest nearby quake M ${mag.toFixed(1)}`
        : 'Nearby quake activity',
    )
  } else {
    info.push('No nearby quakes')
  }

  return [...important, ...info]
}

function ScoreStatusTicker(props: {
  score: number | null
  quakePhase: LivePhase
  nwsPhase: LivePhase
  nhcPhase: LivePhase
  quakes: UsgsFeature[]
  alerts: NwsAlertFeature[]
  atlanticStorms: NhcStorm[]
}) {
  const { score, quakePhase, nwsPhase, nhcPhase, quakes, alerts, atlanticStorms } =
    props
  const headline = scoreStatusHeadline(score)
  const items = buildScoreTickerItems({
    quakePhase,
    nwsPhase,
    nhcPhase,
    quakes,
    alerts,
    atlanticStorms,
  })
  const viewportRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const itemKey = items.join('|')

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduceMotion(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useLayoutEffect(() => {
    const vp = viewportRef.current
    const measure = measureRef.current
    if (!vp || !measure) return
    const check = () => {
      setOverflowing(measure.scrollWidth > vp.clientWidth + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(vp)
    ro.observe(measure)
    return () => ro.disconnect()
  }, [itemKey])

  const scrolling = overflowing && !reduceMotion
  const wrapping = overflowing && reduceMotion

  const line = (
    <>
      {items.map((item, i) => (
        <span key={`${item}-${i}`} className="score-ticker__seg">
          {i > 0 ? (
            <span className="score-ticker__sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </>
  )

  return (
    <div className={`score-status ${scoreToneClass(score)}`}>
      <p className="score-status__line">
        <span className="score-status__dot" aria-hidden="true" />
        <span className="score-status__label">{headline.label}</span>
        <span className="score-status__dash" aria-hidden="true">
          —
        </span>
        <span className="score-status__summary">{headline.summary}</span>
      </p>
      <div
        className={
          wrapping ? 'score-ticker score-ticker--wrap' : 'score-ticker'
        }
        ref={viewportRef}
      >
        <div className="score-ticker__measure" ref={measureRef} aria-hidden="true">
          {line}
        </div>
        <div
          className={
            scrolling ? 'score-ticker__track is-scroll' : 'score-ticker__track'
          }
        >
          <span className="score-ticker__copy">{line}</span>
          {scrolling ? (
            <span className="score-ticker__copy" aria-hidden="true">
              {line}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function LocationPrefControl(props: {
  source: LocationSource
  phase: GeoPhase
  placeLabel: string | null
  onUseMyLocation: () => void
  onUseVirginiaBeach: () => void
}) {
  const { source, phase, placeLabel, onUseMyLocation, onUseVirginiaBeach } = props
  const locating = phase === 'locating'
  const usingBrowser = source === 'browser' && phase === 'ready'
  const failed =
    phase === 'denied' || phase === 'unavailable' || phase === 'timeout'

  const viewingCurrent = placeLabel
    ? `Viewing: ${placeLabel} · Current location`
    : 'Viewing: Current location'

  const failMessage =
    phase === 'denied'
      ? 'Location permission denied — using Virginia Beach'
      : phase === 'timeout'
        ? 'Location timed out — using Virginia Beach'
        : 'Location unavailable — using Virginia Beach'

  return (
    <p className="score-summary__loc">
      {locating && <span>Locating...</span>}
      {usingBrowser && (
        <>
          <span>{viewingCurrent}</span>
          <button type="button" onClick={onUseVirginiaBeach}>
            Use Virginia Beach
          </button>
        </>
      )}
      {failed && (
        <>
          <span>{failMessage}</span>
          <button type="button" onClick={onUseMyLocation}>
            Retry location
          </button>
        </>
      )}
      {!locating && !usingBrowser && !failed && (
        <>
          <span>Viewing: Virginia Beach, VA · Default</span>
          <button type="button" onClick={onUseMyLocation}>
            Use my location
          </button>
        </>
      )}
    </p>
  )
}

function LocationOnboardPrompt(props: {
  locating: boolean
  onAllowLocation: () => void
  onUseVirginiaBeach: () => void
}) {
  const { locating, onAllowLocation, onUseVirginiaBeach } = props
  return (
    <div className="loc-onboard" role="dialog" aria-modal="true" aria-labelledby="loc-onboard-title">
      <div className="loc-onboard__card">
        <h2 id="loc-onboard-title" className="loc-onboard__title">
          Use your location?
        </h2>
        <p className="loc-onboard__body">
          CoastCast can use your location for local alerts, radar, forecasts, and nearby
          events.
        </p>
        <div className="loc-onboard__actions">
          <button
            type="button"
            className="loc-onboard__allow"
            onClick={onAllowLocation}
            disabled={locating}
          >
            {locating ? 'Locating...' : 'Allow location'}
          </button>
          <button
            type="button"
            className="loc-onboard__vb"
            onClick={onUseVirginiaBeach}
            disabled={locating}
          >
            Use Virginia Beach
          </button>
        </div>
      </div>
    </div>
  )
}

function App() {
  const [quakePhase, setQuakePhase] = useState<LivePhase>('loading')
  const [quakes, setQuakes] = useState<UsgsFeature[]>([])
  const [quakeError, setQuakeError] = useState('')

  const [weatherAlertPhase, setWeatherAlertPhase] = useState<LivePhase>('loading')
  const [weatherAlerts, setWeatherAlerts] = useState<NwsAlertFeature[]>([])
  const [weatherAlertError, setWeatherAlertError] = useState('')
  const [weatherAlertFetchedAt, setWeatherAlertFetchedAt] = useState<Date | null>(null)

  const [nhcPhase, setNhcPhase] = useState<LivePhase>('loading')
  const [atlanticStorms, setAtlanticStorms] = useState<NhcStorm[]>([])
  const [nhcError, setNhcError] = useState('')

  const [quakeFetchedAt, setQuakeFetchedAt] = useState<Date | null>(null)
  const [nhcFetchedAt, setNhcFetchedAt] = useState<Date | null>(null)

  const [forecastPhase, setForecastPhase] = useState<LivePhase>('loading')
  const [forecastDays, setForecastDays] = useState<ForecastDay[]>([])
  const [forecastError, setForecastError] = useState('')
  const [forecastFetchedAt, setForecastFetchedAt] = useState<Date | null>(null)

  const [skywatchPhase, setSkywatchPhase] = useState<LivePhase>('loading')
  const [skywatchSunMoon, setSkywatchSunMoon] = useState<SkywatchSunMoon | null>(null)
  const [skywatchEvent, setSkywatchEvent] = useState<NasaSkyEvent | null>(null)
  const [skywatchError, setSkywatchError] = useState('')
  const [skywatchFetchedAt, setSkywatchFetchedAt] = useState<Date | null>(null)

  const [preferMyLocation, setPreferMyLocation] = useState(false)
  const [coords, setCoords] = useState<GeoCoords>(VB_COORDS)
  const [locationSource, setLocationSource] = useState<LocationSource>('virginia-beach')
  const [geoPhase, setGeoPhase] = useState<GeoPhase>('idle')
  const [placeLabel, setPlaceLabel] = useState<string | null>(null)
  const [showLocationOnboard, setShowLocationOnboard] = useState(
    shouldShowMobileLocationOnboard,
  )
  const geoSeq = useRef(0)
  const nwsLabelCtrl = useRef<AbortController | null>(null)
  const userInvokedGeo = useRef(false)

  const fallbackToVirginiaBeach = useCallback((phase: GeoPhase) => {
    nwsLabelCtrl.current?.abort()
    writeUseMyLocationPref(false)
    setPreferMyLocation(false)
    setCoords(VB_COORDS)
    setLocationSource('virginia-beach')
    setPlaceLabel(null)
    setGeoPhase(phase)
  }, [])

  const applyBrowserPosition = useCallback(async (next: GeoCoords, seq: number) => {
    if (seq !== geoSeq.current) return
    writeUseMyLocationPref(true)
    writeChoseVirginiaBeachPref(false)
    setPreferMyLocation(true)
    setCoords(next)
    setLocationSource('browser')
    setShowLocationOnboard(false)
    nwsLabelCtrl.current?.abort()
    const ctrl = new AbortController()
    nwsLabelCtrl.current = ctrl
    let label: string | null = null
    try {
      label = await fetchNwsPointLabel(next.latitude, next.longitude, ctrl.signal)
    } catch {
      label = null
    }
    if (seq !== geoSeq.current) return
    setPlaceLabel(label)
    setGeoPhase('ready')
  }, [])

  const failBrowserPosition = useCallback(
    (err: unknown, seq: number) => {
      if (seq !== geoSeq.current) return
      if (err instanceof Error && err.name === 'AbortError') return
      setShowLocationOnboard(false)
      fallbackToVirginiaBeach(geoPhaseFromError(err))
    },
    [fallbackToVirginiaBeach],
  )

  const useVirginiaBeach = useCallback(() => {
    geoSeq.current += 1
    setShowLocationOnboard(false)
    fallbackToVirginiaBeach('idle')
  }, [fallbackToVirginiaBeach])

  const useMyLocation = useCallback(() => {
    userInvokedGeo.current = true
    const seq = ++geoSeq.current
    setPreferMyLocation(true)
    setGeoPhase('locating')
    setPlaceLabel(null)
    requestBrowserLocation()
      .then((next) => applyBrowserPosition(next, seq))
      .catch((err) => failBrowserPosition(err, seq))
  }, [applyBrowserPosition, failBrowserPosition])

  const onboardAllowLocation = useCallback(() => {
    writeLocationOnboardedPref(true)
    writeChoseVirginiaBeachPref(false)
    useMyLocation()
  }, [useMyLocation])

  const onboardUseVirginiaBeach = useCallback(() => {
    writeLocationOnboardedPref(true)
    writeChoseVirginiaBeachPref(true)
    useVirginiaBeach()
  }, [useVirginiaBeach])

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_LOC_MQ)
    const sync = () => {
      setShowLocationOnboard(shouldShowMobileLocationOnboard())
    }
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!showLocationOnboard) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [showLocationOnboard])

  useEffect(() => {
    if (!readUseMyLocationPref()) return
    let cancelled = false
    ;(async () => {
      const perm = await geolocationPermissionState()
      if (cancelled || userInvokedGeo.current) return
      if (perm === 'granted') {
        const seq = ++geoSeq.current
        setPreferMyLocation(true)
        setGeoPhase('locating')
        setPlaceLabel(null)
        try {
          const next = await requestBrowserLocation()
          await applyBrowserPosition(next, seq)
        } catch (err: unknown) {
          failBrowserPosition(err, seq)
        }
        return
      }
      if (!isMobileLocationViewport()) return
      nwsLabelCtrl.current?.abort()
      setPreferMyLocation(false)
      setCoords(VB_COORDS)
      setLocationSource('virginia-beach')
      setPlaceLabel(null)
      setGeoPhase(perm === 'denied' ? 'denied' : 'unavailable')
    })()
    return () => {
      cancelled = true
    }
  }, [applyBrowserPosition, failBrowserPosition])

  useEffect(() => {
    if (preferMyLocation && geoPhase === 'locating') {
      setQuakePhase('loading')
      return
    }

    const point =
      locationSource === 'browser' && geoPhase === 'ready' ? coords : VB_COORDS
    const url = usgsQuakesUrl(point.latitude, point.longitude)
    const ctrl = new AbortController()
    setQuakePhase('loading')
    ;(async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal })
        if (!res.ok) throw new Error(`USGS responded with ${res.status}`)
        const data: { features?: UsgsFeature[] } = await res.json()
        const raw = Array.isArray(data.features) ? data.features : []
        const useful = raw.filter(
          (f) =>
            f.properties != null &&
            typeof f.properties.time === 'number' &&
            f.properties.place &&
            f.properties.mag != null,
        )
        setQuakes(useful)
        setQuakeFetchedAt(new Date())
        setQuakePhase('ready')
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setQuakeError(e instanceof Error ? e.message : 'Could not load quakes')
        setQuakePhase('error')
      }
    })()
    return () => ctrl.abort()
  }, [
    preferMyLocation,
    geoPhase,
    locationSource,
    coords.latitude,
    coords.longitude,
  ])

  useEffect(() => {
    if (preferMyLocation && geoPhase === 'locating') {
      setWeatherAlertPhase('loading')
      return
    }

    const point =
      locationSource === 'browser' && geoPhase === 'ready' ? coords : VB_COORDS
    const url = nwsActiveAlertsUrl(point.latitude, point.longitude)
    const ctrl = new AbortController()
    setWeatherAlertPhase('loading')
    ;(async () => {
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: NWS_FETCH_HEADERS,
        })
        if (!res.ok) throw new Error(`NWS responded with ${res.status}`)
        const data: { features?: NwsAlertFeature[] } = await res.json()
        const raw = Array.isArray(data.features) ? data.features : []
        const useful = raw.filter(
          (f) =>
            f.properties != null &&
            (f.properties.headline || f.properties.event),
        )
        setWeatherAlerts(useful)
        setWeatherAlertFetchedAt(new Date())
        setWeatherAlertPhase('ready')
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setWeatherAlertError(
          e instanceof Error ? e.message : 'Could not load alerts',
        )
        setWeatherAlertPhase('error')
      }
    })()
    return () => ctrl.abort()
  }, [
    preferMyLocation,
    geoPhase,
    locationSource,
    coords.latitude,
    coords.longitude,
  ])

  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(NHC_CURRENT_STORMS_URL, {
          signal: ctrl.signal,
          headers: NHC_FETCH_HEADERS,
        })
        if (!res.ok) throw new Error(`NHC responded with ${res.status}`)
        const data: { activeStorms?: NhcStorm[] } = await res.json()
        const raw = Array.isArray(data.activeStorms) ? data.activeStorms : []
        const atlantic = raw.filter(isAtlanticNhcStorm)
        setAtlanticStorms(atlantic)
        setNhcFetchedAt(new Date())
        setNhcPhase('ready')
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setNhcError(e instanceof Error ? e.message : 'Could not load NHC storms')
        setNhcPhase('error')
      }
    })()
    return () => ctrl.abort()
  }, [])

  useEffect(() => {
    if (preferMyLocation && geoPhase === 'locating') {
      setForecastPhase('loading')
      return
    }

    const point =
      locationSource === 'browser' && geoPhase === 'ready' ? coords : VB_COORDS
    const ctrl = new AbortController()
    setForecastPhase('loading')
    ;(async () => {
      try {
        const pointsRes = await fetch(nwsPointsUrl(point.latitude, point.longitude), {
          signal: ctrl.signal,
          headers: NWS_FETCH_HEADERS,
        })
        if (!pointsRes.ok) throw new Error(`NWS points responded with ${pointsRes.status}`)
        const pointsData: unknown = await pointsRes.json()
        const props =
          pointsData && typeof pointsData === 'object'
            ? (pointsData as {
                properties?: { forecast?: unknown; forecastHourly?: unknown }
              }).properties
            : undefined
        const forecastUrl =
          typeof props?.forecast === 'string' ? props.forecast : ''
        if (!forecastUrl || !isUsableHttpUrl(forecastUrl)) {
          throw new Error('NWS did not return a forecast URL')
        }
        const hourlyUrl =
          typeof props?.forecastHourly === 'string' && isUsableHttpUrl(props.forecastHourly)
            ? props.forecastHourly
            : ''

        const [forecastRes, hourlyRes] = await Promise.all([
          fetch(forecastUrl, { signal: ctrl.signal, headers: NWS_FETCH_HEADERS }),
          hourlyUrl
            ? fetch(hourlyUrl, { signal: ctrl.signal, headers: NWS_FETCH_HEADERS })
            : Promise.resolve(null),
        ])
        if (!forecastRes.ok) {
          throw new Error(`NWS forecast responded with ${forecastRes.status}`)
        }
        const forecastData: unknown = await forecastRes.json()
        const periodsRaw =
          forecastData && typeof forecastData === 'object'
            ? (forecastData as { properties?: { periods?: unknown } }).properties
                ?.periods
            : undefined
        const periods = Array.isArray(periodsRaw)
          ? (periodsRaw as NwsForecastPeriod[])
          : []

        let hourly: NwsForecastPeriod[] = []
        if (hourlyRes && hourlyRes.ok) {
          const hourlyData: unknown = await hourlyRes.json()
          const hourlyRaw =
            hourlyData && typeof hourlyData === 'object'
              ? (hourlyData as { properties?: { periods?: unknown } }).properties
                  ?.periods
              : undefined
          if (Array.isArray(hourlyRaw)) hourly = hourlyRaw as NwsForecastPeriod[]
        }

        setForecastDays(pickDaytimeForecasts(periods, hourly))
        setForecastError('')
        setForecastFetchedAt(new Date())
        setForecastPhase('ready')
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setForecastError(
          e instanceof Error ? e.message : 'Could not load forecast',
        )
        setForecastDays([])
        setForecastPhase('error')
      }
    })()
    return () => ctrl.abort()
  }, [
    preferMyLocation,
    geoPhase,
    locationSource,
    coords.latitude,
    coords.longitude,
  ])

  useEffect(() => {
    if (preferMyLocation && geoPhase === 'locating') {
      setSkywatchPhase('loading')
      return
    }

    const point =
      locationSource === 'browser' && geoPhase === 'ready' ? coords : VB_COORDS
    const ctrl = new AbortController()
    setSkywatchPhase('loading')
    ;(async () => {
      try {
        let timeZone: string | null = null
        try {
          timeZone = await fetchNwsTimeZone(
            point.latitude,
            point.longitude,
            ctrl.signal,
          )
        } catch {
          timeZone = null
        }
        if (!timeZone && point.latitude === VB_LAT && point.longitude === VB_LON) {
          timeZone = 'America/New_York'
        }

        const now = new Date()
        let localYmd: string
        let tzHours: number
        if (timeZone) {
          localYmd = localYmdInTimeZone(timeZone, now)
          tzHours = utcOffsetHours(timeZone, now)
        } else {
          tzHours = lonGuessOffsetHours(point.longitude)
          const shifted = new Date(now.getTime() + tzHours * 3_600_000)
          const y = shifted.getUTCFullYear()
          const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
          const d = String(shifted.getUTCDate()).padStart(2, '0')
          localYmd = `${y}-${m}-${d}`
        }

        setSkywatchEvent(nextNasaSkyEvent(localYmd))

        const coordsParam =
          point.latitude === VB_LAT && point.longitude === VB_LON
            ? '36.8529,-75.9780'
            : `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`
        const usnoUrl = `${USNO_ONEDAY_URL}?date=${encodeURIComponent(localYmd)}&coords=${encodeURIComponent(coordsParam)}&tz=${encodeURIComponent(formatUsnoTz(tzHours))}`
        const usnoRes = await fetch(usnoUrl, { signal: ctrl.signal })
        if (!usnoRes.ok) {
          throw new Error(`USNO responded with ${usnoRes.status}`)
        }
        const usnoData: unknown = await usnoRes.json()
        const sunMoon = parseUsnoOneday(usnoData)
        if (!sunMoon.sunrise && !sunMoon.sunset && !sunMoon.moonPhase) {
          throw new Error('USNO did not return usable sun/moon values')
        }
        setSkywatchSunMoon(sunMoon)
        setSkywatchError('')
        setSkywatchFetchedAt(new Date())
        setSkywatchPhase('ready')
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setSkywatchSunMoon(null)
        setSkywatchError(
          e instanceof Error ? e.message : 'Could not load skywatch data',
        )
        setSkywatchFetchedAt(null)
        setSkywatchPhase('error')
      }
    })()
    return () => ctrl.abort()
  }, [
    preferMyLocation,
    geoPhase,
    locationSource,
    coords.latitude,
    coords.longitude,
  ])

  const usingCurrentLocation =
    locationSource === 'browser' && geoPhase === 'ready'
  const scoreLocationName = usingCurrentLocation
    ? (placeLabel ?? 'your location')
    : 'Virginia Beach'
  const scorePlaceLine = usingCurrentLocation
    ? `${placeLabel ?? 'Your location'} coastal conditions`
    : 'Virginia Beach coastal conditions'

  const score = computeVbScore({
    quakePhase,
    nwsPhase: weatherAlertPhase,
    nhcPhase,
    quakes,
    alerts: weatherAlerts,
    atlanticStorms,
    locationName: scoreLocationName,
  })

  return (
    <div className="app">
      <main className="main">
        <div className="dashboard">
          <div className="dashboard__left">
            <div className="dashboard__top">
            <section className="card score-summary" aria-label={`${scoreLocationName} relevance score`}>
              <div className="score-summary__row">
                <div className="score-summary__intro">
                  <h1 className="brand">
                    <span className="brand__coast">Coast</span>
                    <span className="brand__cast">Cast</span>
                  </h1>
                  <p className="score-summary__place">{scorePlaceLine}</p>
                </div>
                <div className={`score-summary__metric ${scoreToneClass(score.score)}`}>
                  <div className="score-summary__value" aria-hidden="true">
                    <span className="score-summary__num">
                      {score.score == null ? '…' : score.score}
                    </span>
                  </div>
                  <p className="score-summary__status">Status · {score.status}</p>
                </div>
              </div>
              <ScoreStatusTicker
                score={score.score}
                quakePhase={quakePhase}
                nwsPhase={weatherAlertPhase}
                nhcPhase={nhcPhase}
                quakes={quakes}
                alerts={weatherAlerts}
                atlanticStorms={atlanticStorms}
              />
              <LocationPrefControl
                source={locationSource}
                phase={geoPhase}
                placeLabel={placeLabel}
                onUseMyLocation={useMyLocation}
                onUseVirginiaBeach={useVirginiaBeach}
              />
            </section>
              <NwsAlertsCard
                phase={weatherAlertPhase}
                alerts={weatherAlerts}
                errorMessage={weatherAlertError}
                fetchedAt={weatherAlertFetchedAt}
              />
            </div>

            <WindyMapCard
              latitude={coords.latitude}
              longitude={coords.longitude}
              usingCurrentLocation={usingCurrentLocation}
              placeLabel={placeLabel}
            />
          </div>

          <aside className="panels" aria-label="Condition panels">
            <SkywatchCard
              phase={skywatchPhase}
              sunMoon={skywatchSunMoon}
              nextEvent={skywatchEvent}
              errorMessage={skywatchError}
              fetchedAt={skywatchFetchedAt}
            />

            <HurricanesCard
              phase={nhcPhase}
              storms={atlanticStorms}
              errorMessage={nhcError}
              fetchedAt={nhcFetchedAt}
              latitude={coords.latitude}
              longitude={coords.longitude}
              usingCurrentLocation={usingCurrentLocation}
              placeLabel={placeLabel}
              weatherAlerts={weatherAlerts}
              weatherAlertPhase={weatherAlertPhase}
            />

            <QuakesCard
              phase={quakePhase}
              items={quakes}
              errorMessage={quakeError}
              fetchedAt={quakeFetchedAt}
              usingCurrentLocation={usingCurrentLocation}
              placeLabel={placeLabel}
            />

            <ForecastCard
              phase={forecastPhase}
              days={forecastDays}
              errorMessage={forecastError}
              fetchedAt={forecastFetchedAt}
            />
          </aside>
        </div>
      </main>
      {showLocationOnboard ? (
        <LocationOnboardPrompt
          locating={geoPhase === 'locating'}
          onAllowLocation={onboardAllowLocation}
          onUseVirginiaBeach={onboardUseVirginiaBeach}
        />
      ) : null}
    </div>
  )
}

export default App
