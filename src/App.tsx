import { useCallback, useEffect, useState } from 'react'
import './App.css'

const VB_LAT = 36.8529
const VB_LON = -75.978

const USE_MY_LOCATION_PREF_KEY = 'coastcast-use-my-location'

const USGS_QUAKES_URL =
  'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=36.8529&longitude=-75.9780&maxradiuskm=805&minmagnitude=2.5&orderby=time&limit=20'

/** Virginia Beach oceanfront — NWS active alerts for this point */
const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?point=36.8529,-75.9780'

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

/** Subset of NHC CurrentStorms.json storm objects we read (see NHC JSON reference). */
type NhcStorm = {
  id?: string
  binNumber?: string
  name?: string
  classification?: string
  intensity?: number
  pressure?: number
  latitude?: string
  longitude?: string
}

function isAtlanticNhcStorm(s: NhcStorm): boolean {
  const bin = (s.binNumber ?? '').toUpperCase()
  if (bin.startsWith('AT')) return true
  const sid = (s.id ?? '').toLowerCase()
  return sid.startsWith('al')
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

function nhcClassificationLabel(code: string | null | undefined): string {
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

/**
 * Live USGS quakes + NWS VB alerts + NHC Atlantic list + marine-style alert subset
 * — 0–100 score, status label, short blurb. Nature / news is not scored.
 */
function computeVbScore(input: {
  quakePhase: LivePhase
  nwsPhase: LivePhase
  nhcPhase: LivePhase
  quakes: UsgsFeature[]
  alerts: NwsAlertFeature[]
  atlanticStorms: NhcStorm[]
}): ScoreResult {
  const { quakePhase, nwsPhase, nhcPhase, quakes, alerts, atlanticStorms } = input

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

    blurb = bits.length > 0 ? `${bits.join(', ')}.` : 'Conditions around Virginia Beach.'
  }

  return { score, status, blurb }
}

const metaMuted: React.CSSProperties = {
  marginTop: '0.65rem',
  fontSize: '0.75rem',
  color: 'rgba(200, 210, 225, 0.55)',
  lineHeight: 1.4,
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

function QuakesCard(props: {
  phase: LivePhase
  items: UsgsFeature[]
  errorMessage: string
  fetchedAt: Date | null
}) {
  const { phase, items, errorMessage, fetchedAt } = props
  const shown = items.slice(0, 3)

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

  const footerTime =
    fetchedAt != null
      ? fetchedAt.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : null

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
          No recent earthquakes showed up within 500 miles of Virginia Beach — the
          coast is seismically quiet for now.
        </p>
      )}

      {phase === 'ready' && shown.length > 0 && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>
            Latest from USGS (within 500 miles of Virginia Beach, M2.5+):
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

      <p style={metaMuted}>
        {phase === 'loading' && 'Last updated · loading…'}
        {phase === 'error' && 'Last updated · —'}
        {phase === 'ready' && footerTime != null && `Last updated · USGS · ${footerTime}`}
      </p>
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

  const footerTime =
    fetchedAt != null
      ? fetchedAt.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : null

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

      <p style={metaMuted}>
        {phase === 'loading' && 'Last updated · loading…'}
        {phase === 'error' && 'Last updated · —'}
        {phase === 'ready' && footerTime != null && `Last updated · NWS · ${footerTime}`}
      </p>
    </section>
  )
}

function HurricanesCard(props: {
  phase: LivePhase
  storms: NhcStorm[]
  errorMessage: string
  fetchedAt: Date | null
}) {
  const { phase, storms, errorMessage, fetchedAt } = props
  const shown = storms.slice(0, 5)

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
      label: 'Clear',
      style: {
        ...badgeBase,
        background: 'rgba(120, 190, 255, 0.1)',
        borderColor: 'rgba(120, 190, 255, 0.3)',
        color: 'rgba(170, 215, 255, 0.95)',
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

  const footerTime =
    fetchedAt != null
      ? fetchedAt.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : null

  return (
    <section className="card panel">
      <div style={panelHead}>
        <h2 className="card__title">Hurricanes</h2>
        <span style={badge.style}>{badge.label}</span>
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

      {phase === 'ready' && shown.length === 0 && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>No active Atlantic tropical systems right now.</p>
          <p style={metaMuted}>NHC Atlantic basin</p>
        </div>
      )}

      {phase === 'ready' && shown.length > 0 && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>
            Atlantic systems from NOAA/NHC status (summary positions — not a VB
            track forecast):
          </p>
          {shown.map((s, i) => {
            const name = (s.name && s.name.trim()) || 'Unnamed'
            const cls = nhcClassificationLabel(s.classification)
            const kt =
              typeof s.intensity === 'number' && Number.isFinite(s.intensity)
                ? `${s.intensity} kt`
                : 'intensity n/a'
            const mb =
              typeof s.pressure === 'number' && Number.isFinite(s.pressure)
                ? `${s.pressure} mb`
                : 'pressure n/a'
            const lat = s.latitude?.trim() || 'lat n/a'
            const lon = s.longitude?.trim()
            const where = lon ? `${lat} · ${lon}` : lat
            return (
              <p
                key={s.id ?? `${name}-${i}`}
                style={{ ...quakeLine, marginTop: i === 0 ? '0.5rem' : '0.45rem' }}
              >
                <strong>{name}</strong>
                {' — '}
                {cls}
                {' · '}
                {kt}
                {' · '}
                {mb}
                {' · '}
                {where}
              </p>
            )
          })}
        </div>
      )}

      <p style={metaMuted}>
        {phase === 'loading' && 'Last updated · loading…'}
        {phase === 'error' && 'Last updated · —'}
        {phase === 'ready' && footerTime != null && `Last updated · NHC · ${footerTime}`}
      </p>
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

  const footerTime =
    fetchedAt != null
      ? fetchedAt.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : null

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

      <p style={metaMuted}>
        {phase === 'loading' && 'Last updated · loading…'}
        {phase === 'error' && 'Last updated · —'}
        {phase === 'ready' && footerTime != null && `Last updated · NWS · ${footerTime}`}
        {phase === 'ready' && footerTime == null && 'Last updated · —'}
      </p>
    </section>
  )
}

function SkywatchCard() {
  return (
    <section className="card panel skywatch-card">
      <div style={panelHead}>
        <h2 className="card__title">Skywatch</h2>
        <span
          style={{
            ...badgeBase,
            background: 'rgba(129, 140, 248, 0.1)',
            borderColor: 'rgba(129, 140, 248, 0.35)',
            color: 'rgba(196, 181, 253, 0.95)',
          }}
        >
          Clear
        </span>
      </div>

      <div className="panel__body skywatch">
        <p className="skywatch__sunline">
          <span>
            <span className="skywatch__k">Sunrise</span> 6:32 AM
          </span>
          <span className="skywatch__pipe" aria-hidden="true">
            |
          </span>
          <span>
            <span className="skywatch__k">Sunset</span> 7:41 PM
          </span>
        </p>
        <div className="skywatch__row">
          <span>Moon</span>
          <span>Waxing Gibbous · 72%</span>
        </div>
        <p className="skywatch__next-label">Next up</p>
        <p className="skywatch__event">
          <a
            className="skywatch__event-link"
            href="https://science.nasa.gov/solar-system/meteors-meteorites/perseids/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Perseid meteor activity
            <span className="skywatch__ext" aria-hidden="true">
              {' '}
              ↗
            </span>
          </a>
        </p>
        <p className="skywatch__hint">Best viewing: after midnight</p>
      </div>

      <p style={metaMuted}>Virginia Beach sky conditions</p>
    </section>
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

function App() {
  const [quakePhase, setQuakePhase] = useState<LivePhase>('loading')
  const [quakes, setQuakes] = useState<UsgsFeature[]>([])
  const [quakeError, setQuakeError] = useState('')

  const [nwsPhase, setNwsPhase] = useState<LivePhase>('loading')
  const [nwsAlerts, setNwsAlerts] = useState<NwsAlertFeature[]>([])

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

  const [preferMyLocation, setPreferMyLocation] = useState(readUseMyLocationPref)
  const [coords, setCoords] = useState<GeoCoords>(VB_COORDS)
  const [locationSource, setLocationSource] = useState<LocationSource>('virginia-beach')
  const [geoPhase, setGeoPhase] = useState<GeoPhase>(() =>
    readUseMyLocationPref() ? 'locating' : 'idle',
  )
  const [placeLabel, setPlaceLabel] = useState<string | null>(null)
  const [geoAttempt, setGeoAttempt] = useState(0)

  const useVirginiaBeach = useCallback(() => {
    writeUseMyLocationPref(false)
    setPreferMyLocation(false)
    setCoords(VB_COORDS)
    setLocationSource('virginia-beach')
    setPlaceLabel(null)
    setGeoPhase('idle')
  }, [])

  const useMyLocation = useCallback(() => {
    writeUseMyLocationPref(true)
    setPreferMyLocation(true)
    setGeoAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!preferMyLocation) return
    const ctrl = new AbortController()
    let cancelled = false
    setGeoPhase('locating')
    setPlaceLabel(null)
    ;(async () => {
      try {
        const next = await requestBrowserLocation()
        if (cancelled) return
        setCoords(next)
        setLocationSource('browser')
        let label: string | null = null
        try {
          label = await fetchNwsPointLabel(
            next.latitude,
            next.longitude,
            ctrl.signal,
          )
        } catch {
          label = null
        }
        if (cancelled) return
        setPlaceLabel(label)
        setGeoPhase('ready')
      } catch (err: unknown) {
        if (cancelled) return
        if (err instanceof Error && err.name === 'AbortError') return
        setCoords(VB_COORDS)
        setLocationSource('virginia-beach')
        setPlaceLabel(null)
        const code =
          err && typeof err === 'object' && 'code' in err
            ? Number((err as { code: unknown }).code)
            : NaN
        setGeoPhase(
          code === 1 ? 'denied' : code === 3 ? 'timeout' : 'unavailable',
        )
      }
    })()
    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [preferMyLocation, geoAttempt])

  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(USGS_QUAKES_URL, { signal: ctrl.signal })
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
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(NWS_ALERTS_URL, {
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
        setNwsAlerts(useful)
        setNwsPhase('ready')
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setNwsPhase('error')
      }
    })()
    return () => ctrl.abort()
  }, [])

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

  const score = computeVbScore({
    quakePhase,
    nwsPhase,
    nhcPhase,
    quakes,
    alerts: nwsAlerts,
    atlanticStorms,
  })

  return (
    <div className="app">
      <main className="main">
        <div className="dashboard">
          <div className="dashboard__left">
            <div className="dashboard__top">
            <section className="card score-summary" aria-label="Virginia Beach relevance score">
              <div className="score-summary__row">
                <div className="score-summary__intro">
                  <h1 className="brand">
                    <span className="brand__coast">Coast</span>
                    <span className="brand__cast">Cast</span>
                  </h1>
                  <p className="score-summary__place">Virginia Beach coastal conditions</p>
                </div>
                <div className="score-summary__metric">
                  <div className="score-summary__value" aria-hidden="true">
                    {score.score == null ? '…' : score.score}
                  </div>
                  <p className="score-summary__status">Status · {score.status}</p>
                </div>
              </div>
              <p className="score-summary__blurb">{score.blurb}</p>
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
              usingCurrentLocation={
                locationSource === 'browser' && geoPhase === 'ready'
              }
              placeLabel={placeLabel}
            />
          </div>

          <aside className="panels" aria-label="Condition panels">
            <SkywatchCard />

            <HurricanesCard
              phase={nhcPhase}
              storms={atlanticStorms}
              errorMessage={nhcError}
              fetchedAt={nhcFetchedAt}
            />

            <QuakesCard
              phase={quakePhase}
              items={quakes}
              errorMessage={quakeError}
              fetchedAt={quakeFetchedAt}
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
    </div>
  )
}

export default App
