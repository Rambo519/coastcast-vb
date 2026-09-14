/**
 * CoastCast v0.9.1 threat engine.
 * Final score = max(source scores) + limited distinct-source bonus (not a sum of all hazards).
 */

import {
  forecastTrend,
  haversineMiles,
  nhcFiniteNumber,
  pointInAnyPolygon,
  stormCenter,
  type HurricaneTrend,
  type NhcStorm,
  type NhcStormProducts,
  type NhcTrackPoint,
} from './nhcRelevance'

export type ThreatStatusLabel =
  | 'CALM'
  | 'LOW'
  | 'AWARE'
  | 'ELEVATED'
  | 'HIGH'
  | 'SEVERE'
  | 'EXTREME'
  | 'LOADING'

export type ThreatScoreResult = {
  score: number | null
  status: ThreatStatusLabel
  summary: string
  blurb: string
  sources: {
    nwsAlertScore: number
    forecastScore: number
    hurricaneScore: number
    quakeScore: number
  }
}

export type ThreatAlert = {
  properties?: {
    event?: string | null
    severity?: string | null
  } | null
}

export type ThreatForecastPeriod = {
  startTime?: string | null
  shortForecast?: string | null
  windSpeed?: string | null
}

export type ThreatQuake = {
  properties: {
    mag: number | null
  }
}

const KT_TO_MPH = 1.1507794

/** Exact normalized NWS properties.event → score. Explicit map always wins. */
export const NWS_EVENT_SCORES: Readonly<Record<string, number>> = {
  'tornado warning': 100,
  'extreme wind warning': 100,
  'hurricane warning': 95,
  'storm surge warning': 95,
  'flash flood warning': 85,
  'hurricane watch': 75,
  'storm surge watch': 75,
  'severe thunderstorm warning': 70,
  'tropical storm warning': 70,
  'blizzard warning': 70,
  'high wind warning': 55,
  'flood warning': 55,
  'tornado watch': 50,
  'tropical storm watch': 50,
  'winter storm warning': 50,
  'coastal flood warning': 50,
  'lakeshore flood warning': 50,
  'excessive heat warning': 40,
  'red flag warning': 40,
  'severe thunderstorm watch': 35,
  'flood watch': 30,
  'winter storm watch': 30,
  'coastal flood watch': 30,
  'lakeshore flood watch': 30,
  'coastal flood advisory': 20,
  'lakeshore flood advisory': 20,
  'flood advisory': 15,
  'wind advisory': 15,
  'heat advisory': 15,
  'dense fog advisory': 10,
  'special weather statement': 10,
  'small craft advisory': 10,
}

const SEVERITY_FALLBACK: Readonly<Record<string, number>> = {
  extreme: 70,
  severe: 45,
  moderate: 20,
  minor: 10,
  unknown: 5,
}

export function normalizeNwsEventName(event: string | null | undefined): string {
  return (event ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function singleAlertScore(alert: ThreatAlert): number {
  const key = normalizeNwsEventName(alert.properties?.event)
  if (key && Object.prototype.hasOwnProperty.call(NWS_EVENT_SCORES, key)) {
    return NWS_EVENT_SCORES[key]
  }
  const sev = (alert.properties?.severity ?? '').trim().toLowerCase()
  if (sev && Object.prototype.hasOwnProperty.call(SEVERITY_FALLBACK, sev)) {
    return SEVERITY_FALLBACK[sev]
  }
  return 5
}

/** One score: maximum matching local point alert. Never sum alerts. */
export function nwsAlertScore(alerts: ThreatAlert[]): number {
  let max = 0
  for (const a of alerts) {
    const pts = singleAlertScore(a)
    if (pts > max) max = pts
  }
  return max
}

function parseWindMph(raw: string | null | undefined): number | null {
  if (!raw) return null
  const nums = [...raw.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
  const finite = nums.filter((n) => Number.isFinite(n))
  if (finite.length === 0) return null
  return Math.max(...finite)
}

function periodWeatherBaseline(shortForecast: string | null | undefined): number {
  const t = (shortForecast ?? '').toLowerCase()
  if (!t.trim()) return 0
  if (/freezing rain|sleet|\bice\b|icy/.test(t)) return 15
  if (/thunder|t-storm|tstm|thunderstorm/.test(t)) return 10
  if (/\bsnow\b|blizzard|flurries|wintry/.test(t)) return 10
  if (/\brain\b|shower|drizzle/.test(t)) return 5
  return 0
}

function windBaseline(mph: number | null): number {
  if (mph == null) return 0
  if (mph >= 50) return 30
  if (mph >= 35) return 20
  if (mph >= 25) return 10
  return 0
}

/**
 * Next ~6 hours of hourly forecast only. Max of applicable baselines; never sum.
 */
export function forecastScore(
  hourly: ThreatForecastPeriod[],
  now = new Date(),
): number {
  if (!hourly.length) return 0
  const horizonMs = now.getTime() + 6 * 60 * 60 * 1000
  let max = 0
  let anyInWindow = false
  for (const period of hourly) {
    const start = period.startTime ? new Date(period.startTime) : null
    if (start && !Number.isNaN(start.getTime())) {
      if (start.getTime() > horizonMs) continue
      // Skip periods that ended more than ~1h ago if end missing — start in past is ok for current hour
      if (start.getTime() < now.getTime() - 60 * 60 * 1000) continue
    }
    anyInWindow = true
    const wx = periodWeatherBaseline(period.shortForecast)
    const wind = windBaseline(parseWindMph(period.windSpeed))
    max = Math.max(max, wx, wind)
  }
  if (!anyInWindow) {
    // If timestamps missing, use the first few hourly rows as "now + next hours"
    const slice = hourly.slice(0, 6)
    for (const period of slice) {
      const wx = periodWeatherBaseline(period.shortForecast)
      const wind = windBaseline(parseWindMph(period.windSpeed))
      max = Math.max(max, wx, wind)
    }
  }
  return max
}

function intensityClassBase(mph: number): number {
  if (mph >= 157) return 100 // Cat 5
  if (mph >= 130) return 90 // Cat 4
  if (mph >= 111) return 75 // Cat 3
  if (mph >= 96) return 65 // Cat 2
  if (mph >= 74) return 55 // Cat 1
  if (mph >= 39) return 40 // TS
  return 20 // TD / weaker
}

function intensityMphFromStorm(storm: NhcStorm): number | null {
  const raw = nhcFiniteNumber(storm.intensity)
  if (raw == null) return null
  // NHC CurrentStorms intensity is sustained wind in knots.
  return Math.round(raw * KT_TO_MPH)
}

function intensityMphFallback(storm: NhcStorm): number {
  const fromField = intensityMphFromStorm(storm)
  if (fromField != null) return fromField
  const c = (storm.classification ?? '').toUpperCase()
  if (c === 'HU') return 74
  if (c === 'TS' || c === 'STS') return 50
  if (c === 'TD' || c === 'STD') return 30
  return 25
}

function closestTrackApproach(
  location: { lat: number; lon: number },
  trackPoints: NhcTrackPoint[],
): { miles: number; intensityMph: number | null } | null {
  if (trackPoints.length === 0) return null
  let best = trackPoints[0]
  let bestMiles = haversineMiles(location, best)
  for (let i = 1; i < trackPoints.length; i++) {
    const p = trackPoints[i]
    const d = haversineMiles(location, p)
    if (d < bestMiles) {
      bestMiles = d
      best = p
    }
  }
  return {
    miles: bestMiles,
    intensityMph: best.intensityMph ?? null,
  }
}

function insideDistanceAdj(miles: number): number {
  if (miles <= 75) return 10
  if (miles <= 150) return 5
  if (miles <= 300) return 0
  if (miles <= 500) return -10
  return -20
}

function outsideDistanceMax(miles: number): number {
  if (miles <= 75) return 50
  if (miles <= 150) return 40
  if (miles <= 400) return 25
  if (miles <= 750) return 10
  return 0
}

function trendAdj(trend: HurricaneTrend): number {
  if (trend === 'Approaching') return 5
  if (trend === 'Moving away') return -10
  return 0
}

function tropicalAlertFloor(alerts: ThreatAlert[]): number {
  let floor = 0
  for (const a of alerts) {
    const key = normalizeNwsEventName(a.properties?.event)
    if (key === 'hurricane warning' || key === 'storm surge warning') {
      floor = Math.max(floor, 95)
    } else if (key === 'hurricane watch' || key === 'storm surge watch') {
      floor = Math.max(floor, 75)
    } else if (key === 'tropical storm warning') {
      floor = Math.max(floor, 70)
    } else if (key === 'tropical storm watch') {
      floor = Math.max(floor, 50)
    }
  }
  return floor
}

/** Local relevance for one Atlantic system. No points for mere existence. */
export function singleStormHurricaneScore(input: {
  storm: NhcStorm
  location: { lat: number; lon: number }
  products: NhcStormProducts | undefined
  alerts: ThreatAlert[]
}): number {
  const { storm, location, products, alerts } = input
  const center = stormCenter(storm)
  const currentMiles = center ? haversineMiles(location, center) : null
  const track = products?.trackPoints ?? []
  const approach = closestTrackApproach(location, track)
  const forecastMilesList = track.map((p) => haversineMiles(location, p))
  const closestForecastMiles =
    approach?.miles ??
    (forecastMilesList.length > 0 ? Math.min(...forecastMilesList) : null)
  const distanceMiles =
    closestForecastMiles ?? currentMiles

  const insideCone =
    Boolean(products?.coneKnown) &&
    pointInAnyPolygon(location, products?.coneRings ?? [])

  const intensityMph =
    approach?.intensityMph ?? intensityMphFallback(storm)
  const base = intensityClassBase(intensityMph)
  const trend = forecastTrend(currentMiles, forecastMilesList)
  const tAdj = trendAdj(trend)

  let score: number
  if (insideCone) {
    const dAdj = distanceMiles != null ? insideDistanceAdj(distanceMiles) : 0
    score = clamp(base + dAdj + tAdj, 0, 100)
  } else {
    if (distanceMiles != null && distanceMiles > 750) {
      score = 0
    } else if (distanceMiles == null) {
      // No usable distance and not inside cone → not locally relevant without WW floor
      score = 0
    } else {
      const capped = Math.min(base + tAdj, outsideDistanceMax(distanceMiles))
      score = clamp(capped, 0, 100)
    }
  }

  const floor = tropicalAlertFloor(alerts)
  return Math.max(score, floor)
}

/** Highest locally relevant Atlantic system score. */
export function hurricaneScore(input: {
  storms: NhcStorm[]
  location: { lat: number; lon: number }
  productsById: Record<string, NhcStormProducts | undefined>
  alerts: ThreatAlert[]
  nhcPhase: 'loading' | 'ready' | 'error'
}): number {
  const { storms, location, productsById, alerts, nhcPhase } = input
  if (nhcPhase !== 'ready') {
    // Still apply local tropical alert floors from NWS even if NHC feed is down.
    return tropicalAlertFloor(alerts)
  }
  if (storms.length === 0) return tropicalAlertFloor(alerts)

  let max = 0
  storms.forEach((storm, i) => {
    const id = storm.id ?? storm.name ?? `storm-${i}`
    const pts = singleStormHurricaneScore({
      storm,
      location,
      products: productsById[id],
      alerts,
    })
    if (pts > max) max = pts
  })
  // Floors already applied per-storm; also ensure bare tropical alerts count
  // when storm geometry is missing.
  return Math.max(max, tropicalAlertFloor(alerts))
}

/**
 * Prior magnitude formula as a single quakeScore (max one quake, never sum).
 * (mag - 2.5) * 10, clamped 0–36.
 */
export function quakeScore(quakes: ThreatQuake[]): number {
  let maxMag: number | null = null
  for (const q of quakes) {
    const m = q.properties.mag
    if (m == null || !Number.isFinite(m)) continue
    if (maxMag == null || m > maxMag) maxMag = m
  }
  if (maxMag == null) return 0
  return Math.round(clamp((maxMag - 2.5) * 10, 0, 36))
}

/** Combine four source scores: highest + up to +10 for other strong sources. */
export function combineThreatScores(sources: {
  nwsAlertScore: number
  forecastScore: number
  hurricaneScore: number
  quakeScore: number
}): number {
  const values = [
    sources.nwsAlertScore,
    sources.forecastScore,
    sources.hurricaneScore,
    sources.quakeScore,
  ]
  const sorted = [...values].sort((a, b) => b - a)
  const baseScore = sorted[0] ?? 0
  let bonus = 0
  if ((sorted[1] ?? 0) >= 25) bonus += 5
  if ((sorted[2] ?? 0) >= 25) bonus += 5
  return Math.min(100, baseScore + bonus)
}

export function statusFromThreatScore(score: number): {
  status: Exclude<ThreatStatusLabel, 'LOADING'>
  summary: string
} {
  if (score <= 0) return { status: 'CALM', summary: 'No immediate local threats' }
  if (score <= 9) return { status: 'LOW', summary: 'Minor conditions nearby' }
  if (score <= 24) return { status: 'AWARE', summary: 'Conditions worth watching' }
  if (score <= 44) return { status: 'ELEVATED', summary: 'Active weather may affect you' }
  if (score <= 69) return { status: 'HIGH', summary: 'Significant local hazard' }
  if (score <= 89) return { status: 'SEVERE', summary: 'Dangerous local conditions' }
  return { status: 'EXTREME', summary: 'Immediate serious threat' }
}

/** Display-only tone bands adapted to v0.9.1 status ranges (5 existing colors). */
export function scoreToneClass(score: number | null): string {
  if (score == null) return 'score-summary__metric--pending'
  if (score <= 9) return 'score-summary__metric--t0'
  if (score <= 24) return 'score-summary__metric--t1'
  if (score <= 44) return 'score-summary__metric--t2'
  if (score <= 69) return 'score-summary__metric--t3'
  return 'score-summary__metric--t4'
}

export function computeCoastCastScore(input: {
  quakePhase: 'loading' | 'ready' | 'error'
  nwsPhase: 'loading' | 'ready' | 'error'
  nhcPhase: 'loading' | 'ready' | 'error'
  forecastPhase: 'loading' | 'ready' | 'error'
  quakes: ThreatQuake[]
  alerts: ThreatAlert[]
  hourly: ThreatForecastPeriod[]
  atlanticStorms: NhcStorm[]
  productsById: Record<string, NhcStormProducts | undefined>
  location: { lat: number; lon: number }
  locationName: string
}): ThreatScoreResult {
  const {
    quakePhase,
    nwsPhase,
    nhcPhase,
    forecastPhase,
    quakes,
    alerts,
    hourly,
    atlanticStorms,
    productsById,
    location,
    locationName,
  } = input

  if (quakePhase === 'loading' || nwsPhase === 'loading') {
    return {
      score: null,
      status: 'LOADING',
      summary: 'Checking latest conditions',
      blurb: 'Checking latest conditions…',
      sources: {
        nwsAlertScore: 0,
        forecastScore: 0,
        hurricaneScore: 0,
        quakeScore: 0,
      },
    }
  }

  const nws = nwsPhase === 'ready' ? nwsAlertScore(alerts) : 0
  const forecast = forecastPhase === 'ready' ? forecastScore(hourly) : 0
  const cane = hurricaneScore({
    storms: atlanticStorms,
    location,
    productsById,
    alerts: nwsPhase === 'ready' ? alerts : [],
    nhcPhase,
  })
  const quake = quakePhase === 'ready' ? quakeScore(quakes) : 0

  const sources = {
    nwsAlertScore: nws,
    forecastScore: forecast,
    hurricaneScore: cane,
    quakeScore: quake,
  }
  const score = combineThreatScores(sources)
  const { status, summary } = statusFromThreatScore(score)

  const quakesQuiet = quakePhase === 'ready' && quakes.length === 0
  const alertsClear = nwsPhase === 'ready' && alerts.length === 0
  const atlanticClear = nhcPhase === 'ready' && atlanticStorms.length === 0

  let blurb: string
  if (quakesQuiet && alertsClear && atlanticClear && score <= 0) {
    blurb =
      'Quiet overall — no nearby quakes, no active weather alerts, and no Atlantic tropical systems.'
  } else {
    const bits: string[] = []
    if (quakePhase === 'error') bits.push('earthquake data unavailable')
    else if (quakes.length > 0) {
      let maxMag: number | null = null
      for (const q of quakes) {
        const m = q.properties.mag
        if (m == null) continue
        if (maxMag == null || m > maxMag) maxMag = m
      }
      bits.push(
        maxMag != null
          ? `strongest nearby quake about M ${maxMag.toFixed(1)}`
          : 'nearby quake activity',
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

  return { score, status, summary, blurb, sources }
}
