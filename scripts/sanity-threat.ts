/**
 * CoastCast v0.9.1 threat-engine sanity checks (no UI).
 * Run: npx --yes tsx scripts/sanity-threat.ts
 */
import {
  combineThreatScores,
  forecastScore,
  nwsAlertScore,
  quakeScore,
  singleStormHurricaneScore,
  statusFromThreatScore,
} from '../src/threatScore'
import type { NhcStorm, NhcStormProducts } from '../src/nhcRelevance'

function assertEq(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} → ${String(actual)} (expected ${String(expected)})`)
  if (!ok) process.exitCode = 1
}

function alert(event: string) {
  return { properties: { event } }
}

function emptyProducts(over: Partial<NhcStormProducts> = {}): NhcStormProducts {
  return {
    trackPoints: [],
    coneRings: [],
    coneKnown: false,
    wwKnown: true,
    wwIssued: false,
    ...over,
  }
}

const loc = { lat: 36.85, lon: -75.98 }

console.log('--- CoastCast v0.9.1 sanity ---')

assertEq('clear status', statusFromThreatScore(0).status, 'CALM')
assertEq('clear score', combineThreatScores({ nwsAlertScore: 0, forecastScore: 0, hurricaneScore: 0, quakeScore: 0 }), 0)

assertEq('rain', forecastScore([{ startTime: new Date().toISOString(), shortForecast: 'Rain', windSpeed: '5 mph' }]), 5)
assertEq('rain status', statusFromThreatScore(5).status, 'LOW')

assertEq(
  'thunderstorms',
  forecastScore([{ startTime: new Date().toISOString(), shortForecast: 'Thunderstorms', windSpeed: '10 mph' }]),
  10,
)
assertEq('tstorm status', statusFromThreatScore(10).status, 'AWARE')

assertEq('Flood Advisory', nwsAlertScore([alert('Flood Advisory')]), 15)
assertEq('Coastal Flood Advisory', nwsAlertScore([alert('Coastal Flood Advisory')]), 20)
assertEq('Flood Watch', nwsAlertScore([alert('Flood Watch')]), 30)
assertEq('Severe Thunderstorm Watch', nwsAlertScore([alert('Severe Thunderstorm Watch')]), 35)
assertEq('Tornado Watch', nwsAlertScore([alert('Tornado Watch')]), 50)
assertEq('Flood Warning', nwsAlertScore([alert('Flood Warning')]), 55)
assertEq('Severe Thunderstorm Warning', nwsAlertScore([alert('Severe Thunderstorm Warning')]), 70)
assertEq('Flash Flood Warning', nwsAlertScore([alert('Flash Flood Warning')]), 85)
assertEq('Tornado Warning', nwsAlertScore([alert('Tornado Warning')]), 100)
assertEq('Hurricane Warning', nwsAlertScore([alert('Hurricane Warning')]), 95)

const cat5: NhcStorm = {
  id: 'AL992026',
  name: 'Test',
  classification: 'HU',
  intensity: 140, // kt ≈ 161 mph Cat 5
  latitudeNumeric: 36.9,
  longitudeNumeric: -76.0,
}
const cat5Products = emptyProducts({
  coneKnown: true,
  coneRings: [
    [
      { lat: 37.5, lon: -76.5 },
      { lat: 37.5, lon: -75.5 },
      { lat: 36.2, lon: -75.5 },
      { lat: 36.2, lon: -76.5 },
      { lat: 37.5, lon: -76.5 },
    ],
  ],
  trackPoints: [
    { lat: 36.9, lon: -76.05, intensityMph: 161 },
    { lat: 37.2, lon: -76.2, intensityMph: 161 },
  ],
})
const cat5Score = singleStormHurricaneScore({
  storm: cat5,
  location: loc,
  products: cat5Products,
  alerts: [],
})
assertEq('Cat5 in cone <=75 approaching', cat5Score, 100)

const cat3: NhcStorm = {
  id: 'AL982026',
  name: 'Test3',
  classification: 'HU',
  intensity: 100, // kt ≈ 115 mph Cat 3
  // Current center ~200 mi from VB so trend stays neutral vs forecast
  latitudeNumeric: 34.0,
  longitudeNumeric: -75.98,
}
const cat3Products = emptyProducts({
  coneKnown: true,
  coneRings: [
    [
      { lat: 37.5, lon: -76.5 },
      { lat: 37.5, lon: -75.5 },
      { lat: 36.2, lon: -75.5 },
      { lat: 36.2, lon: -76.5 },
      { lat: 37.5, lon: -76.5 },
    ],
  ],
  // Closest approach ~200 miles, little change / neutral
  trackPoints: [
    { lat: 34.0, lon: -75.98, intensityMph: 115 },
    { lat: 34.05, lon: -75.98, intensityMph: 115 },
  ],
})
const cat3Score = singleStormHurricaneScore({
  storm: cat3,
  location: loc,
  products: cat3Products,
  alerts: [],
})
assertEq('Cat3 in cone 151-300 neutral', cat3Score, 75)

const far: NhcStorm = {
  id: 'AL972026',
  name: 'Far',
  classification: 'HU',
  intensity: 130,
  latitudeNumeric: 20.0,
  longitudeNumeric: -50.0,
}
const farProducts = emptyProducts({
  coneKnown: true,
  coneRings: [
    [
      { lat: 22, lon: -52 },
      { lat: 22, lon: -48 },
      { lat: 18, lon: -48 },
      { lat: 18, lon: -52 },
      { lat: 22, lon: -52 },
    ],
  ],
  trackPoints: [
    { lat: 21, lon: -49, intensityMph: 150 },
    { lat: 19, lon: -45, intensityMph: 140 },
  ],
})
const farScore = singleStormHurricaneScore({
  storm: far,
  location: loc,
  products: farProducts,
  alerts: [],
})
assertEq('Major outside cone >750 moving away', farScore, 0)

assertEq('Ohio Flash Flood', nwsAlertScore([alert('Flash Flood Warning')]), 85)
assertEq('Lakeshore Flood Warning', nwsAlertScore([alert('Lakeshore Flood Warning')]), 50)

assertEq(
  'three minor alerts do not sum',
  nwsAlertScore([
    alert('Dense Fog Advisory'),
    alert('Special Weather Statement'),
    alert('Small Craft Advisory'),
  ]),
  10,
)

const combo = combineThreatScores({
  nwsAlertScore: 85,
  forecastScore: 0,
  hurricaneScore: 0,
  quakeScore: quakeScore([{ properties: { mag: 5.0 } }]),
})
assertEq('Flash Flood 85 + quake>=25 bonus', combo, 90)
assertEq('quake alone M5', quakeScore([{ properties: { mag: 5.0 } }]), 25)

console.log('done')
