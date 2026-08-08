/* NEM fuel-mix dashboard (LAB-419).
 *
 * Consumes GET /api/v2/values/aggregate?group_by=fuel (worker/API.md, the
 * pinned public contract) — `timestamps` and each series' `values` are used
 * as-is; the only client-side math is the cumulative transform a stacked
 * area needs for rendering. Raw net MW is always what the readout shows.
 *
 * Values are NET MW (contract): a fuel band can go negative (batteries
 * charging, station load). Stacking is therefore diverging: each fuel is
 * split into a positive and a negative half, each half cumulated within its
 * own group, so positives stack up from zero and negatives stack down —
 * per-interval correct even when a series flips sign mid-window. Band/dir
 * semantics follow uPlot's stacked-series demo (MIT, leeoniya/uPlot).
 */

/* The fuel palette + stack order live in stacking.js (pure, unit-tested).
 * Palette derived with the dataviz skill and passed by its six-checks
 * validator (CVD-simulated adjacent-pair separation, lightness band, chroma
 * floor, contrast) against the exact surfaces in tailwind.css: light
 * #ffffff, dark #1d232a. Order IS the CVD-safety mechanism — thermal at the
 * base, variable renewables on top, battery above them; do not reorder or
 * eyeball-edit hexes without re-running the validator.
 * Known WARNs, both relieved by the always-visible readout values (the
 * mandated relief channel): solar #eda100 is 2.17:1 on white; fossil #8f4d0f
 * is 2.44:1 on the dark surface. */
import { buildStack, orderSeries } from './stacking.js';
import { bucketLabel, DEFAULT_RANGE, RANGES, rangeQuery } from './ranges.js';

const REGIONS = [
  ['', 'NEM'], ['QLD1', 'QLD'], ['NSW1', 'NSW'],
  ['VIC1', 'VIC'], ['SA1', 'SA'], ['TAS1', 'TAS'],
];

const TZ = 'Australia/Brisbane'; // NEM market time: AEST, UTC+10, never DST (not Sydney)
const fmtMW = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
const fmtPct = new Intl.NumberFormat('en-AU', { style: 'percent', maximumFractionDigits: 1 });
const fmtTime = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

const $ = (id) => document.getElementById(id);
const chartEl = $('chart');

/* intensity (LAB-1698): { values, coverage } — values in gCO2-e/kWh aligned
 * to payload.timestamps (null where the API had no factored generation or no
 * matching bucket); null altogether when the intensity fetch failed. The
 * overlay is best-effort chrome on top of the fuel view: its failure never
 * blocks the chart. */
const state = { region: '', range: DEFAULT_RANGE, payload: null, ordered: [], chart: null, intensity: null, showIntensity: true };

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
function chartTokens() {
  const style = getComputedStyle(document.documentElement);
  return {
    surface: style.getPropertyValue('--chart-surface').trim(),
    grid: style.getPropertyValue('--chart-grid').trim(),
    axisInk: style.getPropertyValue('--chart-axis-ink').trim(),
    intensityInk: style.getPropertyValue('--chart-intensity-ink').trim(),
  };
}

function renderChart() {
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  chartEl.textContent = '';
  if (!state.payload || state.payload.timestamps.length === 0) return;

  const theme = currentTheme();
  const tokens = chartTokens();
  const { data, seriesOpts, bands } = buildStack(state.ordered, theme, tokens.surface, state.payload.timestamps);
  const width = chartEl.clientWidth || 640;
  const height = Math.max(280, Math.min(420, Math.round(width * 0.45)));
  const axis = {
    stroke: tokens.axisInk,
    grid: { stroke: tokens.grid, width: 1 },
    ticks: { stroke: tokens.grid, width: 1 },
  };
  const axes = [
    { ...axis, label: 'Time (AEST)', labelSize: 22 },
    { ...axis, label: 'MW (net)', size: 64, values: (u, vals) => vals.map((v) => fmtMW.format(v)) },
  ];
  const scales = {
    y: { range: (u, min, max) => [min < 0 ? min * 1.06 : 0, max > 0 ? max * 1.04 : 1] },
  };

  // Carbon-intensity overlay (LAB-1698): a 2px neutral-ink LINE on its own
  // right-hand scale — a ratio (g/kWh) sharing a time axis with the MW stack,
  // never the MW scale. Appended after the stack rows so band indices from
  // buildStack stay valid. Ink is --chart-intensity-ink (see tailwind.css for
  // the CVD/contrast validation notes); identity is carried by mark shape
  // (line vs fill) + the labeled axis + the readout, not by hue.
  const overlay = state.showIntensity && state.intensity !== null;
  if (overlay) {
    data.push(state.intensity.values);
    seriesOpts.push({
      label: 'CO₂ intensity',
      scale: 'co2',
      stroke: tokens.intensityInk,
      width: 2,
      points: { show: false },
    });
    scales.co2 = { range: (u, min, max) => [0, (max > 0 ? max : 1) * 1.08] };
    axes.push({
      ...axis,
      scale: 'co2',
      side: 1,
      label: 'gCO₂-e/kWh',
      size: 56,
      grid: { show: false }, // one grid only — the MW grid owns the plot
      values: (u, vals) => vals.map((v) => fmtMW.format(v)),
    });
  }

  state.chart = new uPlot({
    width,
    height,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), TZ),
    // uPlot's default tick templates are US date order; flip to day/month.
    fmtDate: (tpl) => uPlot.fmtDate(tpl.replace('{M}/{D}/{YY}', '{D}/{M}/{YY}').replace('{M}/{D}', '{D}/{M}')),
    series: seriesOpts,
    bands,
    scales,
    axes,
    cursor: { y: false, points: { show: false } },
    legend: { show: false },
    hooks: { setCursor: [(u) => renderReadout(u.cursor.idx)] },
  }, data, chartEl);
}

/* The readout doubles as legend and tooltip: one row per fuel (rect swatch =
 * area mark), raw net MW at the hovered bucket, latest bucket otherwise.
 * Always visible — it is the relief channel for the two sub-3:1 fills and
 * the "every value reachable without hover" guarantee. Untrusted API keys go
 * in via textContent only. */
function renderReadout(cursorIdx) {
  const { payload, ordered } = state;
  const readout = $('readout');
  readout.textContent = '';
  if (!payload || payload.timestamps.length === 0) {
    $('readout-time').textContent = '';
    return;
  }
  const idx = cursorIdx ?? payload.timestamps.length - 1;
  const ts = payload.timestamps[idx];
  // Bucket width from the resolution the API says it served, not the one we
  // asked for — a daily bucket must not claim a 5-minute interval.
  $('readout-time').textContent =
    `${bucketLabel(payload.resolution)} ending ${fmtTime.format(ts * 1e3)} AEST · ${fmtDate.format(ts * 1e3)}`;

  let total = 0;
  let sawValue = false;
  for (const fuel of [...ordered].reverse()) { // visual top of stack first
    const v = fuel.values[idx];
    if (v != null) { total += v; sawValue = true; }
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2';
    const swatch = document.createElement('span');
    swatch.className = 'inline-block h-3 w-3 shrink-0 rounded-sm';
    swatch.style.backgroundColor = fuel[currentTheme()];
    const name = document.createElement('span');
    name.className = 'truncate text-base-content/70';
    name.textContent = fuel.label;
    const val = document.createElement('span');
    val.className = 'ms-auto font-medium tabular-nums';
    val.textContent = v == null ? '—' : fmtMW.format(v);
    row.append(swatch, name, val);
    readout.append(row);
  }
  const totalRow = document.createElement('div');
  totalRow.className = 'mt-2 flex items-center gap-2 border-t border-base-300 pt-2 font-semibold';
  const totalName = document.createElement('span');
  totalName.textContent = 'Total net MW';
  const totalVal = document.createElement('span');
  totalVal.className = 'ms-auto tabular-nums';
  totalVal.textContent = sawValue ? fmtMW.format(total) : '—';
  totalRow.append(totalName, totalVal);
  readout.append(totalRow);

  // Intensity is a value channel of its own, so it rides the readout whether
  // or not the chart overlay is toggled on (the readout is the relief channel
  // for every number on this page).
  if (state.intensity !== null) {
    const co2 = state.intensity.values[idx];
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2';
    const name = document.createElement('span');
    name.className = 'text-base-content/70';
    name.textContent = 'CO₂ intensity, est.';
    const val = document.createElement('span');
    val.className = 'ms-auto font-medium tabular-nums';
    val.textContent = co2 == null ? '—' : `${fmtMW.format(co2)} g/kWh`;
    row.append(name, val);
    readout.append(row);
  }
}

function renderHero() {
  const { payload, ordered } = state;
  const n = payload ? payload.timestamps.length : 0;
  if (n === 0) {
    $('hero-total').textContent = '—';
    $('hero-asat').textContent = 'No data in this window.';
    return;
  }
  const last = n - 1;
  let total = 0;
  let sawValue = false;
  for (const fuel of ordered) {
    const v = fuel.values[last];
    if (v != null) { total += v; sawValue = true; }
  }
  const ts = payload.timestamps[last] * 1e3;
  // An all-null latest bucket (ingest lag) is "no reading", not 0 MW.
  $('hero-total').textContent = sawValue ? `${fmtMW.format(total)} MW` : '—';
  $('hero-asat').textContent = `as at ${fmtTime.format(ts)} AEST · ${fmtDate.format(ts)}`;

  // Headline intensity stat (LAB-1698): same latest-bucket convention as the
  // MW hero — null is "no reading", never 0. Coverage names the share of
  // generation MW carrying a published factor (the honesty disclosure).
  const co2 = state.intensity?.values[last];
  $('hero-co2').textContent = co2 == null ? '—' : fmtMW.format(co2);
  // Floor to 0.1% so partial coverage can never round UP to a false "100%".
  const coverage = state.intensity?.coverage;
  const floored = coverage == null ? null : Math.floor(coverage * 1000) / 1000;
  $('hero-co2-coverage').textContent = floored == null ? '' : `factors cover ${fmtPct.format(floored)} of MW`;
}

function render() {
  state.ordered = orderSeries(state.payload.series);
  $('truncated-badge').classList.toggle('hidden', !state.payload.truncated);
  renderHero();
  renderChart();
  renderReadout(null);
}

function showError(message) {
  $('error-text').textContent = `Failed to load fuel mix: ${message}`;
  $('error-alert').classList.remove('hidden');
}

// Monotonic token so a slow, stale region response can never overwrite the
// latest selection (or clear a newer request's busy state).
let activeLoad = 0;

/* Fetch the intensity series for a region and align it onto the fuel
 * payload's time axis (the two requests can resolve one interval apart at a
 * cache boundary — join on timestamps, never by index). The range rides along
 * so both endpoints resolve the SAME window and auto-stepped resolution —
 * period-ending timestamps coincide across resolutions, so a mismatched
 * request would join wrong-width buckets, not miss. API units are
 * tCO2-e/MWh; ×1000 → the gCO2-e/kWh the dashboard displays. Returns null on
 * any failure: the overlay is best-effort and must never take down the fuel
 * view. */
async function fetchIntensity(region, range, timestamps) {
  try {
    const res = await fetch(`/api/v2/intensity?${rangeQuery(range)}`
      + (region ? `&region=${encodeURIComponent(region)}` : ''));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    // With a region filter the region series equals NEM (= total of matched),
    // so the requested key is present whenever any series is.
    const series = payload.series.find((s) => s.key === (region || 'NEM'));
    if (!series) return null;
    const byTime = new Map(payload.timestamps.map((t, i) => [t, series.values[i]]));
    return {
      values: timestamps.map((t) => {
        const v = byTime.get(t);
        return v == null ? null : Math.round(v * 1000);
      }),
      coverage: series.coverage,
    };
  } catch (err) {
    console.error('intensity load failed:', err);
    return null;
  }
}

async function load(region, range) {
  const loadId = ++activeLoad;
  // Selection commits immediately (state, buttons, URL) so a click during an
  // in-flight fetch composes with THIS selection, and error-Retry retries
  // what the user actually asked for — only the payload waits on success.
  state.region = region;
  state.range = range;
  syncUrl(region, range);
  renderFilters();
  const url = `/api/v2/values/aggregate?group_by=fuel&${rangeQuery(range)}`
    + (region ? `&region=${encodeURIComponent(region)}` : '');
  chartEl.classList.add('opacity-50'); // refetch keeps the previous frame
  chartEl.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(url);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json()).error ?? detail; } catch { /* non-JSON error body */ }
      throw new Error(detail);
    }
    const payload = await res.json();
    if (loadId !== activeLoad) return;
    state.payload = payload;
    state.intensity = null;
    $('error-alert').classList.add('hidden');
    render();

    // Overlay is best-effort: never gate the fuel view on it (browser fetch
    // has no default timeout). fetchIntensity resolves null on any failure,
    // but render() inside the .then can still throw; the .catch keeps that
    // from becoming an unhandled rejection. The loadId check drops stale
    // responses.
    void fetchIntensity(region, range, payload.timestamps).then((intensity) => {
      if (loadId !== activeLoad) return;
      state.intensity = intensity;
      render();
    }).catch((err) => console.error('intensity overlay failed:', err));
  } catch (err) {
    if (loadId !== activeLoad) return;
    console.error('fuel-mix load failed:', err);
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    if (loadId === activeLoad) {
      chartEl.classList.remove('opacity-50');
      chartEl.removeAttribute('aria-busy');
    }
  }
}

// Selection lives in the URL (shareable links); defaults stay unset so the
// boot URL is unchanged. ?theme= and anything else present are preserved.
function syncUrl(region, range) {
  const qs = new URLSearchParams(location.search);
  if (region) qs.set('region', region); else qs.delete('region');
  if (range !== DEFAULT_RANGE) qs.set('range', range); else qs.delete('range');
  const search = qs.toString();
  history.replaceState(null, '', search ? `?${search}` : location.pathname);
}

/* Region and range are the same control: a daisyUI join group where exactly
 * one button is active, and picking one refetches with BOTH selections
 * applied (they compose on the same endpoint). */
function renderFilter(id, options, selected, pick) {
  const nav = $(id);
  nav.textContent = '';
  for (const { value, label } of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn join-item btn-sm' + (value === selected ? ' btn-active' : '');
    btn.setAttribute('aria-pressed', String(value === selected));
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (value === selected) return;
      pick(value); // load() re-renders the filters as it commits the selection
    });
    nav.append(btn);
  }
}

function renderFilters() {
  renderFilter('region-filter', REGIONS.map(([value, label]) => ({ value, label })),
    state.region, (value) => load(value, state.range));
  renderFilter('range-filter', RANGES.map(({ key, label }) => ({ value: key, label })),
    state.range, (value) => load(state.region, value));
}

// Theme toggle: explicit choice persists; OS changes apply only while the
// user hasn't chosen. Chart colours are canvas-baked, so re-render on switch.
function initTheme() {
  // A valid ?theme= is an explicit choice (it wins at boot) — the OS-change
  // listener must respect it just like a saved toggle.
  const queryTheme = new URLSearchParams(location.search).get('theme');
  const queryExplicit = queryTheme === 'light' || queryTheme === 'dark';
  const toggle = $('theme-toggle');
  toggle.checked = currentTheme() === 'dark';
  toggle.addEventListener('change', () => {
    const theme = toggle.checked ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    renderChart();
    renderReadout(null);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (queryExplicit || localStorage.getItem('theme')) return;
    document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
    toggle.checked = e.matches;
    renderChart();
    renderReadout(null);
  });
}

new ResizeObserver(() => {
  if (!state.chart) return;
  const width = chartEl.clientWidth;
  if (width > 0) {
    state.chart.setSize({ width, height: Math.max(280, Math.min(420, Math.round(width * 0.45))) });
  }
}).observe(chartEl);

$('error-retry').addEventListener('click', () => load(state.region, state.range));

// Overlay toggle re-renders the chart only — the stat and readout keep
// reporting intensity either way (they are the value relief channel).
$('intensity-toggle').addEventListener('change', () => {
  state.showIntensity = $('intensity-toggle').checked;
  renderChart();
});

initTheme();
// Restore selection from the URL (shareable links); unknown values fall back
// to the defaults, so the bare URL still boots identical to before.
{
  const qs = new URLSearchParams(location.search);
  const region = qs.get('region');
  const range = qs.get('range');
  if (REGIONS.some(([value]) => value === region)) state.region = region;
  if (RANGES.some(({ key }) => key === range)) state.range = range;
}
load(state.region, state.range); // renders the filters as it commits
