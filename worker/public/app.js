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

const REGIONS = [
  ['', 'NEM'], ['QLD1', 'QLD'], ['NSW1', 'NSW'],
  ['VIC1', 'VIC'], ['SA1', 'SA'], ['TAS1', 'TAS'],
];

const TZ = 'Australia/Brisbane'; // NEM market time: AEST, UTC+10, never DST (not Sydney)
const fmtMW = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
// The API publishes tCO2-e/MWh; gCO2-e/kWh is the same number x1000 and is
// what people actually quote, so the display unit converts and the axis says so.
const fmtIntensity = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
const fmtTime = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

const $ = (id) => document.getElementById(id);
const chartEl = $('chart');

const state = { region: '', payload: null, intensity: null, showIntensity: true, ordered: [], chart: null };

/* Carbon intensity (LAB-1698) for the selected region, aligned to the fuel
 * payload's buckets by TIMESTAMP rather than by index: both endpoints read the
 * same dispatch data over the same default window so the axes normally match
 * exactly, but a lookup degrades to a gap instead of silently shifting the
 * overlay if they ever don't. Returns null when the overlay has nothing to
 * draw, which is also the honest state before the first CDEII refresh runs. */
function intensityForRegion() {
  const { intensity, payload } = state;
  if (!intensity || !payload) return null;
  const series = intensity.series.find((s) => s.key === (state.region || 'NEM'));
  if (!series) return null;
  const byTime = new Map(intensity.timestamps.map((t, i) => [t, series.values[i]]));
  const values = payload.timestamps.map((t) => byTime.get(t) ?? null);
  return values.some((v) => v != null) ? values : null;
}

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

  // Intensity rides a SECOND y scale (different unit entirely) and is appended
  // last, so it draws on top of the stack and cannot disturb the band indices
  // buildStack computed — bands only ever reference series already in place.
  const intensityValues = state.showIntensity ? intensityForRegion() : null;

  const width = chartEl.clientWidth || 640;
  const height = Math.max(280, Math.min(420, Math.round(width * 0.45)));
  const axis = {
    stroke: tokens.axisInk,
    grid: { stroke: tokens.grid, width: 1 },
    ticks: { stroke: tokens.grid, width: 1 },
  };

  const intensityAxes = [];
  if (intensityValues) {
    const gPerKwh = intensityValues.map((v) => (v == null ? null : v * 1000));
    // Drawn as a CASING (wide surface-colour stroke) under the ink line. No
    // single ink clears 3:1 against every fuel fill in both themes — the
    // palette deliberately spans a lightness band in both directions, so any
    // ink sits close to something (measured: near-black is 2.13:1 on the light
    // battery violet, near-white 2.14:1 on the dark gray). A casing makes the
    // ink's immediate surround the surface colour instead of whatever band it
    // happens to cross, which is 18:1 light / 14:1 dark everywhere. Same
    // mechanism as the 1px surface separator between stacked bands.
    data.push(gPerKwh);
    seriesOpts.push({ scale: 'i', stroke: tokens.surface, width: 5, points: { show: false } });
    data.push(gPerKwh);
    seriesOpts.push({
      label: 'Carbon intensity',
      scale: 'i',
      stroke: tokens.intensityInk,
      width: 2,
      points: { show: false },
    });
    intensityAxes.push({
      ...axis,
      scale: 'i',
      side: 1,
      label: 'gCO₂-e/kWh (est.)',
      size: 62,
      // The left axis already rules the plot; a second grid would be noise.
      grid: { show: false },
      values: (u, vals) => vals.map((v) => fmtIntensity.format(v)),
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
    scales: {
      y: { range: (u, min, max) => [min < 0 ? min * 1.06 : 0, max > 0 ? max * 1.04 : 1] },
      // Anchored at zero: intensity is a magnitude against a carbon-free
      // floor, and an auto-zoomed baseline would exaggerate small swings.
      i: { range: (u, min, max) => [0, max > 0 ? max * 1.1 : 1] },
    },
    axes: [
      { ...axis, label: 'Time (AEST)', labelSize: 22 },
      { ...axis, label: 'MW (net)', size: 64, values: (u, vals) => vals.map((v) => fmtMW.format(v)) },
      ...intensityAxes,
    ],
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
  $('readout-time').textContent =
    `Interval ending ${fmtTime.format(ts * 1e3)} AEST · ${fmtDate.format(ts * 1e3)}`;

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

  // Intensity gets a readout row on the same terms as every fuel: a value
  // reachable without hovering, which is what relieves the two sub-3:1 fills.
  // It follows the overlay toggle — a line swatch pointing at a line that is
  // not drawn is worse than no row, and the headline stat carries the number
  // regardless.
  const intensityValues = state.showIntensity ? intensityForRegion() : null;
  if (intensityValues) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 font-semibold';
    const line = document.createElement('span');
    line.className = 'inline-block h-0.5 w-3 shrink-0';
    line.style.backgroundColor = chartTokens().intensityInk;
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = 'gCO₂-e/kWh';
    const val = document.createElement('span');
    val.className = 'ms-auto tabular-nums';
    const v = intensityValues[idx];
    val.textContent = v == null ? '—' : fmtIntensity.format(v * 1000);
    row.append(line, name, val);
    readout.append(row);
  }
}

/* Latest intensity for the selected region, straight from the intensity
 * payload rather than the aligned overlay — the stat should show the freshest
 * reading even if the two windows ever disagree at the edge. */
function renderHeroIntensity() {
  const el = $('hero-intensity');
  const series = state.intensity?.series.find((s) => s.key === (state.region || 'NEM'));
  const latest = series?.values.reduce((acc, v) => (v == null ? acc : v), null) ?? null;
  el.textContent = latest == null ? '—' : `${fmtIntensity.format(latest * 1000)} g`;
  // Coverage is part of the number's meaning, not a footnote: say so on hover.
  const i = series ? series.values.findLastIndex((v) => v != null) : -1;
  const coverage = i >= 0 ? series.coverage[i] : null;
  el.title =
    latest == null
      ? 'No emission factors matched this window — see the method note below.'
      : `gCO₂-e per kWh, estimated. ${
          coverage == null ? '' : `${(coverage * 100).toFixed(1)}% of dispatched MW carried a published factor. `
        }Reads a few percent high (as-generated vs sent-out).`;
}

function renderHero() {
  const { payload, ordered } = state;
  renderHeroIntensity();
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

async function load(region) {
  const loadId = ++activeLoad;
  const url = '/api/v2/values/aggregate?group_by=fuel'
    + (region ? `&region=${encodeURIComponent(region)}` : '');
  chartEl.classList.add('opacity-50'); // refetch keeps the previous frame
  chartEl.setAttribute('aria-busy', 'true');
  try {
    // Intensity carries no region param — the endpoint always returns every
    // region, so one cached response serves the whole selector. Its failure is
    // isolated: an overlay that can't load must not take the fuel mix with it.
    const [res, intensity] = await Promise.all([
      fetch(url),
      fetch('/api/v2/intensity')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .catch((err) => {
          console.error('carbon-intensity load failed:', err);
          return null;
        }),
    ]);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json()).error ?? detail; } catch { /* non-JSON error body */ }
      throw new Error(detail);
    }
    const payload = await res.json();
    if (loadId !== activeLoad) return;
    state.payload = payload;
    state.intensity = intensity;
    state.region = region;
    $('error-alert').classList.add('hidden');
    render();
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

function renderRegionFilter() {
  const nav = $('region-filter');
  nav.textContent = '';
  for (const [value, label] of REGIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn join-item btn-sm' + (value === state.region ? ' btn-active' : '');
    btn.setAttribute('aria-pressed', String(value === state.region));
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      if (value === state.region) return;
      await load(value);
      renderRegionFilter();
    });
    nav.append(btn);
  }
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

$('error-retry').addEventListener('click', () => load(state.region));

// Toggling the overlay is pure re-render — the payload is already in hand.
$('intensity-toggle').addEventListener('change', (e) => {
  state.showIntensity = e.target.checked;
  if (!state.payload) return;
  renderChart();
  renderReadout(null);
});

initTheme();
renderRegionFilter();
load('');
