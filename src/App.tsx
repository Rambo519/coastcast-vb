import { useEffect, useState } from 'react'
import './App.css'

const USGS_QUAKES_URL =
  'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=36.8529&longitude=-75.9780&maxradiuskm=805&minmagnitude=2.5&orderby=time&limit=20'

/** Virginia Beach oceanfront — NWS active alerts for this point */
const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?point=36.8529,-75.9780'

const NWS_FETCH_HEADERS = {
  Accept: 'application/geo+json',
  'User-Agent': 'CoastCastVB/0.1 (Virginia Beach dashboard; educational use)',
} as const

/** NOAA/NHC CurrentStorms.json — in dev, same-origin proxy (see vite.config.ts). */
const NHC_CURRENT_STORMS_URL = import.meta.env.DEV
  ? '/api/nhc-current-storms'
  : 'https://www.nhc.noaa.gov/CurrentStorms.json'

const NHC_FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'CoastCastVB/0.1 (Virginia Beach dashboard; educational use)',
} as const

/** Max Oceanfront-specific lines (live or curated); quality over quantity */
const OCEANFRONT_NATURE_ITEM_MAX = 3

/** Narrow Wikipedia search; results are discarded unless they pass oceanfront-only filters */
const WIKIPEDIA_OCEANFRONT_SEARCH =
  '"Virginia Beach" boardwalk OR "Virginia Beach" oceanfront OR "Virginia Beach" "resort beach"'

const WIKIPEDIA_HEADERS = {
  /** https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy */
  'Api-User-Agent': 'CoastCastVB/0.1 (Virginia Beach dashboard; educational use)',
} as const

type NatureNewsItem = {
  title: string
  summary: string
  url: string
}

function isUsableHttpUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Stable article URL from MediaWiki search `pageid` (avoids broken title slugs). */
function wikiUrlFromPageId(pageid: unknown): string {
  const id = typeof pageid === 'number' ? pageid : Number(pageid)
  if (!Number.isInteger(id) || id <= 0) return ''
  return `https://en.wikipedia.org/?curid=${id}`
}

/**
 * In-app Oceanfront strip only (boardwalk / resort beach / dune line) — used when
 * live search yields nothing acceptable or the request fails.
 */
const OCEANFRONT_CURATED_SNIPPETS: NatureNewsItem[] = [
  {
    title: 'Dunes beside the boardwalk strip',
    summary:
      'Keep off fenced dunes, stay on marked crossings, and treat roped habitat along the Oceanfront sand as closed — it stabilizes the beach and protects shoreline plants.',
    url: 'https://www.virginiabeach.gov/government/departments/parks-recreation',
  },
  {
    title: 'Surf zone & lifeguarded Oceanfront swimming',
    summary:
      'Check flags and staffed towers along the resort beach before you wade; rips run along the open Atlantic beach — this card is FYI only, not a rescue channel.',
    url: 'https://www.virginiabeach.gov/visitors',
  },
  {
    title: 'Beachfront wildlife & lighting (Oceanfront context)',
    summary:
      'Dim unnecessary beachfront lighting during nesting season and give marked turtle or shorebird zones space — follow posted Oceanfront rules if closures are active.',
    url: 'https://www.virginiabeach.gov/',
  },
]

function stripWikiSnippetHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Reject regional / other-beach content; user-requested exclusions are listed here. */
function wikiHitFailsOceanfrontScope(title: string, snippetPlain: string): boolean {
  const blob = `${title} ${snippetPlain}`.toLowerCase()
  const blocked = [
    'assateague',
    'carova',
    'back bay',
    'sandbridge',
    'norfolk',
    'portsmouth',
    'chesapeake',
    'hampton roads',
    'city of hampton',
    'hampton, virginia',
    ', hampton',
    'outer banks',
    'currituck',
    'nags head',
    'kill devil',
    'kitty hawk',
    'chincoteague',
    'first landing',
    'linkhorn',
    'lynnhaven',
    'lynnhaven river',
    'great neck',
    'williamsburg',
    'james river',
    'eastern shore of virginia',
    'accomack',
    'shore drive',
    "chick's beach",
    'chicks beach',
    'croatan',
    'oceana naval',
    'naval air station oceana',
    'delaware',
    'maryland',
    'wrightsville',
    'carolina beach',
    'myrtle beach',
  ]
  return blocked.some((w) => blob.includes(w))
}

/**
 * Require clear Oceanfront / boardwalk / resort-beach shoreline signals (not general
 * "Virginia Beach" city topics unless they tie to the strip).
 */
function wikiHitHasOceanfrontSignals(title: string, snippetPlain: string): boolean {
  const blob = `${title} ${snippetPlain}`.toLowerCase()
  const signals = [
    'oceanfront',
    'boardwalk',
    'beachfront',
    'resort beach',
    'resort area',
    'atlantic avenue',
    'atlantic ave',
    'neptune',
    'virginia beach fishing pier',
    'fishing pier',
    'beach patrol',
    'lifeguard',
    'surf zone',
    'surf rescue',
    'dune',
    'dunes',
    'nesting',
    'sea turtle',
    'shorebird',
    'beach nourishment',
  ]
  return signals.some((s) => blob.includes(s))
}

function wikiHitIsOceanfrontOnly(title: string, snippetPlain: string): boolean {
  if (!title.trim()) return false
  if (wikiHitFailsOceanfrontScope(title, snippetPlain)) return false
  if (!wikiHitHasOceanfrontSignals(title, snippetPlain)) return false
  const blob = `${title} ${snippetPlain}`.toLowerCase()
  const vb =
    blob.includes('virginia beach') ||
    blob.includes(' va beach') ||
    /^virginia beach\b/i.test(title.trim())
  return vb
}

type LivePhase = 'loading' | 'error' | 'ready'

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
    event?: string | null
    headline?: string | null
    areaDesc?: string | null
  } | null
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

function windyEmbedUrl(overlay: WindyLayer): string {
  const product = overlay === 'radar' ? 'radar' : 'ecmwf'
  const q = new URLSearchParams({
    lat: VB_WINDY_LAT,
    lon: VB_WINDY_LON,
    detailLat: VB_WINDY_LAT,
    detailLon: VB_WINDY_LON,
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

function WindyMapCard() {
  const [layer, setLayer] = useState<WindyLayer>('radar')
  const layers: { id: WindyLayer; label: string }[] = [
    { id: 'radar', label: 'RADAR' },
    { id: 'wind', label: 'WIND' },
    { id: 'rain', label: 'RAIN' },
  ]

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
        <p className="map-placeholder__loc">Virginia Beach / Norfolk</p>
      </div>
      <div className="map-placeholder__frame map-placeholder__frame--live">
        <iframe
          className="map-placeholder__iframe"
          title={`Windy ${layer} map of Virginia Beach`}
          src={windyEmbedUrl(layer)}
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
    <section className="card panel">
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
            return (
              <p
                key={f.id ?? `${event}-${i}`}
                style={{ ...quakeLine, marginTop: i === 0 ? '0.5rem' : '0.45rem' }}
              >
                <strong>{event}</strong>
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

function MarineCoastalCard(props: {
  phase: LivePhase
  alerts: NwsAlertFeature[]
  errorMessage: string
  fetchedAt: Date | null
}) {
  const { phase, alerts, errorMessage, fetchedAt } = props
  const coastal = alerts.filter(isMarineCoastalHazardAlert)
  const shown = coastal.slice(0, 4)

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
      label: 'Calm',
      style: {
        ...badgeBase,
        background: 'rgba(120, 200, 160, 0.12)',
        borderColor: 'rgba(120, 200, 160, 0.35)',
        color: 'rgba(180, 235, 205, 0.95)',
      },
    }
  } else {
    badge = {
      label: 'Caution',
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
        <h2 className="card__title">Marine / rip current</h2>
        <span style={badge.style}>{badge.label}</span>
      </div>

      {phase === 'loading' && (
        <p className="panel__body">
          Loading marine and beach-related hazards from the same NWS alert feed as
          your VB ocean point…
        </p>
      )}

      {phase === 'error' && (
        <p className="panel__body">
          Could not read the NWS feed for this card ({errorMessage}). Fix the
          alerts fetch to see marine and beach hazard headlines here too.
        </p>
      )}

      {phase === 'ready' && shown.length === 0 && (
        <p className="panel__body">
          No beach or marine-style watches or warnings jumped out on the official
          NWS feed for the Virginia Beach ocean point — that usually means no
          strong rip or surf headline there right now. Still swim near lifeguards
          and read the posted flags; this panel is not a lifeguard substitute.
        </p>
      )}

      {phase === 'ready' && shown.length > 0 && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>
            Coastal / marine-related NWS alerts for the VB ocean point (subset of
            the live alert feed):
          </p>
          {shown.map((f, i) => {
            const p = f.properties!
            const event = (p.event && p.event.trim()) || 'Alert'
            const line =
              (p.headline && p.headline.trim()) ||
              (p.areaDesc && `Applies to: ${p.areaDesc}`) ||
              'See weather.gov for details.'
            return (
              <p
                key={f.id ?? `${event}-marine-${i}`}
                style={{ ...quakeLine, marginTop: i === 0 ? '0.5rem' : '0.45rem' }}
              >
                <strong>{event}</strong>
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

function NatureNewsTitle(props: { item: NatureNewsItem }) {
  const { item } = props
  if (!isUsableHttpUrl(item.url)) return <>{item.title}</>
  return (
    <a href={item.url} target="_blank" rel="noopener noreferrer">
      {item.title}
    </a>
  )
}

function NatureNewsCard(props: {
  phase: LivePhase
  items: NatureNewsItem[]
  errorMessage: string
  fetchedAt: Date | null
  fromWikipedia: boolean
}) {
  const { phase, items, errorMessage, fetchedAt, fromWikipedia } = props
  const shown = items.slice(0, 2)

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
  } else if (fromWikipedia) {
    badge = {
      label: 'Live',
      style: {
        ...badgeBase,
        background: 'rgba(120, 200, 160, 0.12)',
        borderColor: 'rgba(120, 200, 160, 0.35)',
        color: 'rgba(180, 235, 205, 0.95)',
      },
    }
  } else {
    badge = {
      label: 'FYI',
      style: {
        ...badgeBase,
        background: 'rgba(160, 175, 255, 0.1)',
        borderColor: 'rgba(160, 175, 255, 0.28)',
        color: 'rgba(195, 205, 255, 0.95)',
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

  const footerSource =
    phase === 'loading'
      ? 'loading…'
      : phase === 'error'
        ? 'Wikipedia failed · Oceanfront curated backup'
        : fromWikipedia
          ? 'Wikipedia (Oceanfront-filtered)'
          : 'Oceanfront curated in-app'

  return (
    <section className="card panel panel--nature">
      <div style={panelHead}>
        <h2 className="card__title">Nature / news</h2>
        <span style={badge.style}>{badge.label}</span>
      </div>

      {phase === 'loading' && (
        <p className="panel__body">Loading Oceanfront news…</p>
      )}

      {phase === 'error' && (
        <>
          <p className="panel__body">
            Could not reach Wikipedia ({errorMessage}). Informational only — not a
            hazard feed.
          </p>
          {shown.length > 0 && (
            <div className="panel__body">
              {shown.map((it, i) => (
                <p key={`${it.url}-${i}`} style={{ ...quakeLine, marginTop: i === 0 ? '0.35rem' : '0.3rem' }}>
                  <NatureNewsTitle item={it} />
                  {' — '}
                  {it.summary}
                </p>
              ))}
            </div>
          )}
        </>
      )}

      {phase === 'ready' && shown.length === 0 && (
        <p className="panel__body">No Oceanfront news items right now.</p>
      )}

      {phase === 'ready' && shown.length > 0 && (
        <div className="panel__body">
          <p style={{ margin: 0 }}>Informational news only — not a hazard feed.</p>
          {shown.map((it, i) => (
            <p key={`${it.url}-${i}`} style={{ ...quakeLine, marginTop: i === 0 ? '0.35rem' : '0.3rem' }}>
              <NatureNewsTitle item={it} />
              {' — '}
              {it.summary}
            </p>
          ))}
        </div>
      )}

      <p style={metaMuted}>
        {phase === 'loading' && 'Last updated · loading…'}
        {phase !== 'loading' && footerTime != null && `Last updated · ${footerSource} · ${footerTime}`}
        {phase !== 'loading' && footerTime == null && 'Last updated · —'}
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

function App() {
  const [quakePhase, setQuakePhase] = useState<LivePhase>('loading')
  const [quakes, setQuakes] = useState<UsgsFeature[]>([])
  const [quakeError, setQuakeError] = useState('')

  const [nwsPhase, setNwsPhase] = useState<LivePhase>('loading')
  const [nwsAlerts, setNwsAlerts] = useState<NwsAlertFeature[]>([])
  const [nwsError, setNwsError] = useState('')

  const [nhcPhase, setNhcPhase] = useState<LivePhase>('loading')
  const [atlanticStorms, setAtlanticStorms] = useState<NhcStorm[]>([])
  const [nhcError, setNhcError] = useState('')

  const [quakeFetchedAt, setQuakeFetchedAt] = useState<Date | null>(null)
  const [nwsFetchedAt, setNwsFetchedAt] = useState<Date | null>(null)
  const [nhcFetchedAt, setNhcFetchedAt] = useState<Date | null>(null)

  const [naturePhase, setNaturePhase] = useState<LivePhase>('loading')
  const [natureItems, setNatureItems] = useState<NatureNewsItem[]>([])
  const [natureError, setNatureError] = useState('')
  const [natureFromWiki, setNatureFromWiki] = useState(false)
  const [natureFetchedAt, setNatureFetchedAt] = useState<Date | null>(null)

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
        setNwsFetchedAt(new Date())
        setNwsPhase('ready')
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setNwsError(e instanceof Error ? e.message : 'Could not load alerts')
        setNwsPhase('error')
      }
    })()
    return () => ctrl.abort()
  }, [])

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
    const ctrl = new AbortController()
    const curatedTop = () =>
      OCEANFRONT_CURATED_SNIPPETS.filter((it) => isUsableHttpUrl(it.url)).slice(
        0,
        OCEANFRONT_NATURE_ITEM_MAX,
      )

    ;(async () => {
      try {
        const url = new URL('https://en.wikipedia.org/w/api.php')
        url.searchParams.set('action', 'query')
        url.searchParams.set('list', 'search')
        url.searchParams.set('srsearch', WIKIPEDIA_OCEANFRONT_SEARCH)
        url.searchParams.set('srlimit', '16')
        url.searchParams.set('format', 'json')
        url.searchParams.set('origin', '*')

        const res = await fetch(url.toString(), {
          signal: ctrl.signal,
          headers: WIKIPEDIA_HEADERS,
        })
        if (!res.ok) throw new Error(`Wikipedia responded with ${res.status}`)

        const data = (await res.json()) as {
          error?: { info?: string }
          query?: { search?: { title: string; snippet: string; pageid?: number }[] }
        }
        if (data.error) {
          throw new Error(data.error.info ?? 'Wikipedia search error')
        }
        const hits = data.query?.search
        if (!Array.isArray(hits) || hits.length === 0) {
          setNatureItems(curatedTop())
          setNatureFromWiki(false)
          setNatureError('')
          setNaturePhase('ready')
          setNatureFetchedAt(new Date())
          return
        }

        const mapped: NatureNewsItem[] = []
        for (const h of hits) {
          if (!h.title || mapped.length >= OCEANFRONT_NATURE_ITEM_MAX) continue
          const stripped = stripWikiSnippetHtml(h.snippet)
          if (!wikiHitIsOceanfrontOnly(h.title, stripped)) continue
          const articleUrl = wikiUrlFromPageId(h.pageid)
          if (!isUsableHttpUrl(articleUrl)) continue
          mapped.push({
            title: h.title,
            summary:
              stripped.length > 0
                ? stripped.slice(0, 200)
                : 'Open the Wikipedia article for Oceanfront context.',
            url: articleUrl,
          })
        }

        if (mapped.length === 0) {
          setNatureItems(curatedTop())
          setNatureFromWiki(false)
        } else {
          setNatureItems(mapped)
          setNatureFromWiki(true)
        }
        setNatureError('')
        setNaturePhase('ready')
        setNatureFetchedAt(new Date())
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        setNatureError(e instanceof Error ? e.message : 'Could not load nature/news')
        setNatureItems(
          OCEANFRONT_CURATED_SNIPPETS.filter((it) => isUsableHttpUrl(it.url)).slice(0, 2),
        )
        setNatureFromWiki(false)
        setNaturePhase('error')
        setNatureFetchedAt(new Date())
      }
    })()

    return () => ctrl.abort()
  }, [])

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
            </section>
              <SkywatchCard />
            </div>

            <WindyMapCard />
          </div>

          <aside className="panels" aria-label="Condition panels">
            <NwsAlertsCard
              phase={nwsPhase}
              alerts={nwsAlerts}
              errorMessage={nwsError}
              fetchedAt={nwsFetchedAt}
            />

            <HurricanesCard
              phase={nhcPhase}
              storms={atlanticStorms}
              errorMessage={nhcError}
              fetchedAt={nhcFetchedAt}
            />

            <MarineCoastalCard
              phase={nwsPhase}
              alerts={nwsAlerts}
              errorMessage={nwsError}
              fetchedAt={nwsFetchedAt}
            />

            <QuakesCard
              phase={quakePhase}
              items={quakes}
              errorMessage={quakeError}
              fetchedAt={quakeFetchedAt}
            />

            <NatureNewsCard
              phase={naturePhase}
              items={natureItems}
              errorMessage={natureError}
              fetchedAt={natureFetchedAt}
              fromWikipedia={natureFromWiki}
            />
          </aside>
        </div>
      </main>
    </div>
  )
}

export default App
