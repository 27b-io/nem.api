/* Weather overlay logic for the LAB-1699 dashboard — no DOM, no uPlot, so
 * test/weather.spec.ts can exercise it directly (same split as
 * overlays.js/stacking.js).
 *
 * Source is Open-Meteo (open-meteo.com): no API key, CORS fully open, free
 * for non-commercial use (CC-BY 4.0 — app.js shows the attribution whenever
 * an overlay is on). Fetched client-side straight from the browser; each
 * visitor spends their own IP's free-tier budget, not ours.
 */
import { RANGES } from './ranges.js';

// One reference point per NEM region — capital-city coordinates, NOT a
// capacity-weighted generation centroid (that needs the station-geodata layer
// from the sibling map ticket; out of scope here, see LAB-1699). Good enough
// for VISUAL correlation (a windy day at the state capital tracks a windy day
// across its wind fleet). NEM-wide ('') and unknown regions fall back to NSW1
// (the largest-demand region) in weatherEndpoint rather than inventing a
// five-climate centroid that represents nowhere.
/** @type {Record<string, { lat: number, lon: number }>} */
export const REGION_COORDS = {
  NSW1: { lat: -33.8688, lon: 151.2093 }, // Sydney
  QLD1: { lat: -27.4698, lon: 153.0251 }, // Brisbane
  VIC1: { lat: -37.8136, lon: 144.9631 }, // Melbourne
  SA1: { lat: -34.9285, lon: 138.6007 }, // Adelaide
  TAS1: { lat: -42.8821, lon: 147.3272 }, // Hobart
};

// Open-Meteo hourly variables the overlay can draw. `decimals` drives the
// readout/axis formatter; only one is ever visible at once (app.js), so they
// share a single ink and a single secondary scale rather than needing four
// distinct ones.
//
// `periodEnding`: Open-Meteo labels instantaneous variables (temperature,
// wind) at the instant H, but ACCUMULATED variables at the END of the hour
// they summarise — `shortwave_radiation` at label H is the mean over
// (H-1, H], the same convention as the chart's buckets and the opposite of
// its siblings (verified live against minutely_15). alignWeather keys those
// entries back one hour so the join loop stays single-convention; without
// the flag the whole irradiance curve draws an hour early, which makes solar
// output appear to LAG irradiance — inverting the correlation this overlay
// exists to show.
export const WEATHER_VARS = [
  { key: 'wind_speed_100m', label: 'Wind speed (100 m)', unit: 'km/h', decimals: 0 },
  { key: 'temperature_2m', label: 'Temperature', unit: '°C', decimals: 1 },
  { key: 'shortwave_radiation', label: 'Solar irradiance', unit: 'W/m²', decimals: 0, periodEnding: true },
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

const buildUrl = (base, params) => `${base}?${new URLSearchParams(params)}`;

const isoDate = (d) => d.toISOString().slice(0, 10);

/* The Open-Meteo URL to fetch for a dashboard range/region. `nowMs` is
 * injected (never Date.now() internally) so this stays a pure,
 * deterministically testable function. */
export function weatherEndpoint(range, region, nowMs) {
  // `days` comes off the RANGES table itself (an array — Array.find is immune
  // to inherited-key tricks), so adding a range there automatically carries
  // its weather window. The region lookup is an own-property check, not
  // `?? fallback`: app.js already allowlists both values, but this function
  // is the last stop before a cross-origin fetch, so it must not trust its
  // inputs either — a plain `REGION_COORDS[region] ?? …` lets inherited keys
  // ('constructor', '__proto__') through the fallback and puts undefined
  // coordinates in the URL. The hosts themselves are hardcoded below — no
  // input reaches them.
  const days = (RANGES.find((r) => r.key === range) ?? RANGES[0]).days;
  const { lat, lon } = Object.hasOwn(REGION_COORDS, region) ? REGION_COORDS[region] : REGION_COORDS.NSW1;
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
    return buildUrl('https://api.open-meteo.com/v1/forecast', { ...base, past_days: days, forecast_days: 1 });
  }
  return buildUrl('https://archive-api.open-meteo.com/v1/archive', {
    ...base,
    start_date: isoDate(new Date(nowMs - days * 86400 * 1000)),
    end_date: isoDate(new Date(nowMs)),
  });
}

/* Project an Open-Meteo hourly payload onto the fuel-mix chart's time axis
 * for one variable. `hourly.time` labels are local time (fixed +10, matches
 * `timezone=Australia/Brisbane`), but what a label MEANS depends on the
 * variable: instantaneous readings (temperature, wind) describe the hour
 * STARTING at the label — the opposite convention from the chart's
 * PERIOD-ENDING buckets, so a chart bucket ending exactly on the hour
 * belongs to the label before it, not the label matching it — while
 * accumulated variables (`periodEnding` in WEATHER_VARS) describe the hour
 * ENDING there. Getting either direction backwards is exactly the
 * off-by-one-hour drift the ticket calls out.
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
  // Period-ending variables (see WEATHER_VARS) are keyed back one hour at
  // map-build time, so the join loop below sees a single convention: the map
  // key is always the START of the hour the value describes.
  const shift = WEATHER_VARS.some((v) => v.key === varKey && v.periodEnding) ? HOUR : 0;
  const hourMap = new Map();
  times.forEach((iso, i) => {
    const v = series[i];
    // Number.isFinite, not != null: this payload is a third-party origin's
    // JSON, and a string sneaking in here doesn't throw — it CONCATENATES
    // through the averaging below into a plausible-looking wrong number.
    if (Number.isFinite(v)) hourMap.set(Date.parse(`${iso}:00+10:00`) / 1000 - shift, v);
  });

  const step = Math.max(chartResolution, HOUR);
  chartTimestamps.forEach((t, out) => {
    const lastHour = Math.floor((t - 1) / HOUR) * HOUR; // hour covering the instant just before t
    let sum = 0;
    let n = 0;
    for (let h = lastHour - step + HOUR; h <= lastHour; h += HOUR) {
      const v = hourMap.get(h);
      if (Number.isFinite(v)) { sum += v; n++; }
    }
    if (n > 0) values[out] = sum / n;
  });
  return values;
}
