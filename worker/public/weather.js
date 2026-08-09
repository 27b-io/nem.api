/* Weather overlay logic for the LAB-1699 dashboard — no DOM, no uPlot, so
 * test/weather.spec.ts can exercise it directly (same split as
 * overlays.js/stacking.js).
 *
 * Source is Open-Meteo (open-meteo.com): no API key, CORS fully open, free
 * for non-commercial use (CC-BY 4.0 — app.js shows the attribution whenever
 * an overlay is on). Fetched client-side straight from the browser; each
 * visitor spends their own IP's free-tier budget, not ours.
 */

// One reference point per NEM region, plus a NEM-wide default — capital-city
// coordinates, NOT a capacity-weighted generation centroid (that needs the
// station-geodata layer from the sibling map ticket; out of scope here, see
// LAB-1699). Good enough for VISUAL correlation (a windy day at the state
// capital tracks a windy day across its wind fleet); NEM-wide reuses NSW1
// (the largest-demand region) rather than inventing a five-climate centroid
// that represents nowhere.
/** @type {Record<string, { lat: number, lon: number, place: string }>} */
export const REGION_COORDS = {
  NSW1: { lat: -33.8688, lon: 151.2093, place: 'Sydney' },
  QLD1: { lat: -27.4698, lon: 153.0251, place: 'Brisbane' },
  VIC1: { lat: -37.8136, lon: 144.9631, place: 'Melbourne' },
  SA1: { lat: -34.9285, lon: 138.6007, place: 'Adelaide' },
  TAS1: { lat: -42.8821, lon: 147.3272, place: 'Hobart' },
};
REGION_COORDS[''] = REGION_COORDS.NSW1;

// Open-Meteo hourly variables the overlay can draw. `decimals` drives the
// readout/axis formatter; only one is ever visible at once (app.js), so they
// share a single ink and a single secondary scale rather than needing four
// distinct ones.
export const WEATHER_VARS = [
  { key: 'wind_speed_100m', label: 'Wind speed (100 m)', unit: 'km/h', decimals: 0 },
  { key: 'temperature_2m', label: 'Temperature', unit: '°C', decimals: 1 },
  { key: 'shortwave_radiation', label: 'Solar irradiance', unit: 'W/m²', decimals: 0 },
];

// Not a fuel-palette hue, not the price magenta, and not the achromatic
// demand/intensity tone — validated against its actual neighbours (nearest
// fuel fills, price, battery) with the dataviz six-checks validator.
export const WEATHER_INK = { light: '#5a6fd8', dark: '#8fa0ea' };

// One request always asks for every variable — switching the visible one in
// the UI is then a pure re-render, no refetch (same idea as the intensity
// toggle). Forecast API `past_days` tops out at 92; longer windows need the
// Historical (archive) API instead, which trails ~5 days behind (ERA5) — a
// gap that must render as absent data, not zero (alignWeather leaves it null).
const FORECAST_MAX_DAYS = 92;
const TIMEZONE = 'Australia/Brisbane'; // NEM market time, fixed AEST, never DST

// Approximate day-span per range key (worker/public/ranges.js RANGES) — used
// only to pick an endpoint, so approximate is fine; a day either way just
// shifts the archive window edge, never breaks the query.
const RANGE_DAYS = { '24h': 1, '3d': 3, '7d': 7, '30d': 30, '1y': 366, all: 396 };

function buildUrl(base, params) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return `${base}?${qs}`;
}

const isoDate = (d) => d.toISOString().slice(0, 10);

/* Which Open-Meteo endpoint + URL to fetch for a dashboard range/region.
 * `nowMs` is injected (never Date.now() internally) so this stays a pure,
 * deterministically testable function. */
export function weatherEndpoint(range, region, nowMs) {
  // Own-property lookups, not `?? fallback`: app.js already allowlists both
  // values (REGIONS/RANGES), but this function is the last stop before a
  // cross-origin fetch, so it must not trust its inputs either. A plain
  // `REGION_COORDS[region] ?? …` lets inherited keys ('constructor',
  // '__proto__') through the fallback and puts undefined coordinates in the
  // URL; hasOwn pins every unknown input to the defaults instead. The hosts
  // themselves are hardcoded below — no input reaches them.
  const days = Object.hasOwn(RANGE_DAYS, range) ? RANGE_DAYS[range] : RANGE_DAYS['24h'];
  const { lat, lon } = Object.hasOwn(REGION_COORDS, region) ? REGION_COORDS[region] : REGION_COORDS[''];
  const base = {
    latitude: lat,
    longitude: lon,
    hourly: WEATHER_VARS.map((v) => v.key).join(','),
    timezone: TIMEZONE,
  };
  if (days <= FORECAST_MAX_DAYS) {
    // forecast_days=1, not 0: Open-Meteo's `past_days` window ends at the
    // START of today, so forecast_days=0 would omit today (and "now")
    // entirely — verified live. forecast_days=1 is the smallest value that
    // includes today's completed hours, at the cost of also returning a few
    // genuinely-forecast hours later today; that's harmless here, since the
    // chart never has a bucket later than "now" for alignWeather to look
    // them up against (the dashboard is historical-only, LAB-1699 non-goal).
    return {
      source: 'forecast',
      url: buildUrl('https://api.open-meteo.com/v1/forecast', { ...base, past_days: days, forecast_days: 1 }),
    };
  }
  return {
    source: 'historical',
    url: buildUrl('https://archive-api.open-meteo.com/v1/archive', {
      ...base,
      start_date: isoDate(new Date(nowMs - days * 86400 * 1000)),
      end_date: isoDate(new Date(nowMs)),
    }),
  };
}

/* Project an Open-Meteo hourly payload onto the fuel-mix chart's time axis
 * for one variable. Open-Meteo's `hourly.time` entries are PERIOD-STARTING
 * local (fixed +10, matches `timezone=Australia/Brisbane`) — the opposite
 * convention from the chart's PERIOD-ENDING buckets — so a chart bucket
 * ending exactly on the hour belongs to the hour before it, not the hour
 * starting there; getting this backwards is exactly the off-by-one-hour drift
 * the ticket calls out.
 *
 * At chart resolutions finer than an hour, every bucket in that hour reads
 * the same single reading (piecewise-constant, like the rooftop band). At
 * resolutions coarser than an hour (the daily buckets "1Y"/"All" use), the
 * bucket instead averages every hourly reading it covers — cheap (at most 24
 * additions) and more honest than picking one arbitrary hour out of the day.
 * A bucket with zero covered readings (an ERA5 gap, or before the fetched
 * window) stays null — absent, never zero. */
export function alignWeather(chartTimestamps, chartResolution, weather, varKey) {
  const values = new Array(chartTimestamps.length).fill(null);
  const times = weather?.hourly?.time;
  const series = weather?.hourly?.[varKey];
  if (!Array.isArray(times) || !Array.isArray(series) || times.length === 0) return values;

  const HOUR = 3600;
  const hourMap = new Map();
  times.forEach((iso, i) => {
    const v = series[i];
    if (v != null) hourMap.set(Date.parse(`${iso}:00+10:00`) / 1000, v);
  });

  const step = Math.max(chartResolution, HOUR);
  chartTimestamps.forEach((t, out) => {
    const lastHour = Math.floor((t - 1) / HOUR) * HOUR; // hour covering the instant just before t
    let sum = 0;
    let n = 0;
    for (let h = lastHour - step + HOUR; h <= lastHour; h += HOUR) {
      const v = hourMap.get(h);
      if (v != null) { sum += v; n++; }
    }
    if (n > 0) values[out] = sum / n;
  });
  return values;
}
