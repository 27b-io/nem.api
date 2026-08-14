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
import { $, currentTheme, fetchJson, installTheme, REGIONS, showError, TZ } from './chrome.js';
import { alignOverlays, alignRooftop, OVERLAY_INKS } from './overlays.js';
import { buildStack, orderSeries, ROOFTOP_KEY } from './stacking.js';
import { bucketLabel, DEFAULT_RANGE, RANGES, rangeQuery } from './ranges.js';
import { WEATHER_INK, WEATHER_VARS, alignWeather, weatherEndpoint } from './weather.js';

const fmtMW = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
const fmtPrice = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 2 });
// The API publishes tCO2-e/MWh; gCO2-e/kWh is the same number x1000 and is what
// people actually quote, so every intensity display site multiplies and every
// label says gCO2-e/kWh.
const G_PER_KWH = 1000;
const fmtTime = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

/** "-$60" reads better than "$-60" on an axis; `fmt` picks the precision. */
const dollars = (v, fmt = fmtMW) => (v < 0 ? `-$${fmt.format(-v)}` : `$${fmt.format(v)}`);

// Price-axis tick candidates: symmetric pseudo-log steps to match the asinh
// scale (uPlot distr 4) the price overlay renders on — a $17,500 spike and a
// -$60 trough both stay readable. Filtered to the visible range at render.
const PRICE_SPLITS = [-30000, -10000, -3000, -1000, -300, -100, -30, 0, 30, 100, 300, 1000, 3000, 10000, 30000];

const chartEl = $('chart');

/* dispatch = /api/v2/dispatch payload (all regions; sliced client-side), or
 * null until a price/demand overlay first turns on; aligned = its per-render
 * projection onto the chart's time axis. Price/demand overlays are OFF by
 * default; the intensity overlay (LAB-1698) is ON by default.
 * `aligned`, `intensityAligned` and `intensityInk` are derived once per render in
 * renderChart and read by renderReadout, which runs on every mousemove —
 * recomputing the alignment Maps and a getComputedStyle() per pointer event
 * was measurable. */
const state = {
  region: '',
  range: DEFAULT_RANGE,
  payload: null,
  intensity: null,
  showIntensity: true,
  ordered: [],
  intensityAligned: null,
  intensityInk: '',
  chart: null,
  dispatch: null,
  aligned: null,
  overlays: { price: false, demand: false },
  /* rooftop = /api/v2/rooftop payload (LAB-1701, all regions; sliced
   * client-side like dispatch), or null when the fetch failed — the band
   * degrades to absent, never to zeros. ON by default; the toggle keeps the
   * old grid-scale-only view one click away. */
  rooftop: null,
  showRooftop: true,
  /* Weather overlay (LAB-1699): OFF by default (weatherVar null). One request
   * fetches every variable (wind/temperature/irradiance) together, so
   * switching which is drawn is a pure re-render, like the intensity toggle —
   * only turning it on from off, or a region/range change, needs a fetch.
   * weatherKey stamps which region|range the payload in `weather` answers, so
   * a payload stranded by a failed load() can never be drawn against a newer
   * selection. `weatherVarDef` is the resolved WEATHER_VARS entry, derived
   * once per render like intensityInk (renderReadout runs per mousemove).
   * Failure state is DERIVED (weatherFailed() below), never stored — a
   * stored flag was wrong in both directions when toggles landed mid-load. */
  weatherVar: null,
  weather: null,
  weatherKey: '',
  weatherAligned: null,
  weatherVarDef: null,
};

/** Price needs a single region — the NEM has no NEM-wide spot price. */
const priceDrawable = () => state.overlays.price && state.region !== '';
const overlaysWanted = () => state.overlays.price || state.overlays.demand;

/** The selection the current weather payload would have to answer. */
const weatherKey = () => `${state.region}|${state.range}`;
/* Derived, not stored: a variable is selected but no payload is in hand.
 * True while a fetch is in flight too, but the notice only paints when
 * updateWeatherUi runs — which is always after the fetch settles. */
const weatherFailed = () => state.weatherVar !== null && state.weather === null;

/* Carbon intensity (LAB-1698) for the selected region, aligned to the fuel
 * payload's buckets by TIMESTAMP rather than by index: both endpoints are
 * fetched with the same range query so the axes normally match exactly, but a
 * lookup degrades to a gap instead of silently shifting the overlay if they
 * ever don't (e.g. ingest lag skew at the window edge). Returns null when the
 * overlay has nothing to draw, which is also the honest state before the
 * first CDEII refresh runs. */
function intensityForRegion() {
  const { intensity, payload } = state;
  if (!intensity || !payload) return null;
  const series = intensity.series.find((s) => s.key === (state.region || 'NEM'));
  if (!series) return null;
  const byTime = new Map(intensity.timestamps.map((t, i) => [t, series.values[i]]));
  const values = payload.timestamps.map((t) => byTime.get(t) ?? null);
  return values.some((v) => v != null) ? values : null;
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

  // Overlays (LAB-1700) append AFTER the stack series so band indexes stay
  // valid. Lines, never fills — mark kind is the primary separator from the
  // stacked areas; the always-visible readout is the shared relief channel.
  // Aligned once per render and stashed for renderReadout (which runs on
  // every cursor move — no per-mousemove realignment).
  state.aligned = state.dispatch ? alignOverlays(state.payload.timestamps, state.dispatch, state.region) : null;
  const overlays = state.aligned;
  const showDemand = state.overlays.demand && overlays !== null;
  const showPrice = priceDrawable() && overlays !== null;
  if (showDemand) {
    data.push(overlays.demand);
    seriesOpts.push({
      label: 'Demand',
      scale: 'y', // MW, same unit and scale as the generation stack
      stroke: OVERLAY_INKS.demand[theme],
      width: 2,
      dash: [6, 4],
      points: { show: false },
    });
  }
  if (showPrice) {
    data.push(overlays.price);
    seriesOpts.push({
      label: 'Spot price',
      scale: 'price',
      stroke: OVERLAY_INKS.price[theme],
      width: 2,
      points: { show: false },
    });
  }

  // Intensity rides its own y scale (different unit entirely) and is appended
  // last, so it draws on top of the stack and cannot disturb the band indices
  // buildStack computed — bands only ever reference series already in place.
  const intensityValues = state.showIntensity ? intensityForRegion() : null;
  state.intensityAligned = intensityValues;
  state.intensityInk = tokens.intensityInk;

  const width = chartEl.clientWidth || 640;
  const height = Math.max(280, Math.min(420, Math.round(width * 0.45)));
  const axis = {
    stroke: tokens.axisInk,
    grid: { stroke: tokens.grid, width: 1 },
    ticks: { stroke: tokens.grid, width: 1 },
  };

  const intensityAxes = [];
  if (intensityValues) {
    const gPerKwh = intensityValues.map((v) => (v == null ? null : v * G_PER_KWH));
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
      values: (u, vals) => vals.map((v) => fmtMW.format(v)),
    });
  }

  // Weather overlay (LAB-1699): its own secondary scale, since units differ
  // per variable (km/h / °C / W/m²) — only one is ever drawn, so one scale and
  // one ink cover all three. Aligned once per render like the other
  // overlays; renderReadout re-reads state.weatherAligned on every cursor
  // move. Computed whenever a variable is selected even if the fetch hasn't
  // landed (or failed) — alignWeather degrades a missing payload to an
  // all-null array, which is what lets the readout show "—" instead of
  // nothing at all.
  const weatherVar = WEATHER_VARS.find((v) => v.key === state.weatherVar) ?? null;
  state.weatherVarDef = weatherVar;
  state.weatherAligned = weatherVar
    ? alignWeather(state.payload.timestamps, state.payload.resolution, state.weather, weatherVar.key)
    : null;
  const weatherAxes = [];
  if (state.weatherAligned) {
    data.push(state.weatherAligned);
    seriesOpts.push({
      label: `${weatherVar.label} (${weatherVar.unit})`,
      scale: 'weather',
      stroke: WEATHER_INK[theme],
      width: 2,
      points: { show: false },
    });
    weatherAxes.push({
      ...axis,
      scale: 'weather',
      side: 1,
      size: 64,
      grid: { show: false }, // the MW grid owns the plot; a third grid would lie
      label: `${weatherVar.label} (${weatherVar.unit})`,
      stroke: WEATHER_INK[theme],
      values: (u, vals) => vals.map((v) => v.toFixed(weatherVar.decimals)),
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
      // asinh (uPlot distr 4): linear below ~$100 where prices live day to
      // day, logarithmic toward the caps — a $17,500 spike and a -$60 trough
      // are both readable on one axis without clipping either.
      price: {
        distr: 4,
        asinh: 100,
        range: (u, min, max) => [min < 0 ? min * 1.1 : 0, max > 0 ? max * 1.1 : 1],
      },
      // Anchored at zero: intensity is a magnitude against a carbon-free
      // floor, and an auto-zoomed baseline would exaggerate small swings.
      i: { range: (u, min, max) => [0, max > 0 ? max * 1.1 : 1] },
      // Wind speed and irradiance are magnitudes (anchor at zero, same
      // reasoning as intensity); temperature can go negative, so it gets
      // ordinary padded auto-ranging instead.
      weather: {
        range: (u, min, max) =>
          weatherVar?.key === 'temperature_2m'
            ? [min - Math.abs(min || 1) * 0.1, max + Math.abs(max || 1) * 0.1]
            : [0, max > 0 ? max * 1.1 : 1],
      },
    },
    axes: [
      { ...axis, label: 'Time (AEST)', labelSize: 22 },
      { ...axis, label: 'MW (net)', size: 64, values: (u, vals) => vals.map((v) => fmtMW.format(v)) },
      {
        ...axis,
        scale: 'price',
        side: 1,
        size: 64,
        show: showPrice,
        grid: { show: false }, // the MW grid owns the plot; a second grid would lie
        label: 'Spot price ($/MWh)',
        stroke: OVERLAY_INKS.price[theme],
        // Explicit pseudo-log splits matched to the asinh transform.
        splits: (u) => {
          const { min, max } = u.scales.price;
          const ticks = PRICE_SPLITS.filter((t) => t >= min && t <= max);
          return ticks.length >= 2 ? ticks : [min, max];
        },
        values: (u, vals) => vals.map((v) => dollars(v)),
      },
      ...intensityAxes,
      ...weatherAxes,
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
  // Same honesty rule as the hero (LAB-1701): say whether rooftop is in THIS
  // bucket's total — at the live edge the estimate isn't published yet and
  // the rooftop row above already reads "—".
  const roof = rooftopOrdered();
  totalName.textContent =
    roof === null
      ? 'Total net MW'
      : roof.values[idx] == null
        ? 'Total net MW (excl. rooftop)'
        : 'Total net MW (incl. rooftop est.)';
  const totalVal = document.createElement('span');
  totalVal.className = 'ms-auto tabular-nums';
  totalVal.textContent = sawValue ? fmtMW.format(total) : '—';
  totalRow.append(totalName, totalVal);
  readout.append(totalRow);

  // Intensity gets a readout row on the same terms as every fuel: a value
  // reachable without hovering, which is what relieves the two sub-3:1 fills.
  // It follows the intensity toggle — a line swatch pointing at a line that is
  // not drawn is worse than no row, and the headline stat carries the number
  // regardless. Both inputs were derived in renderChart; this runs per
  // mousemove.
  if (state.intensityAligned) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 font-semibold';
    const line = document.createElement('span');
    line.className = 'inline-block h-0.5 w-3 shrink-0';
    line.style.backgroundColor = state.intensityInk;
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = 'gCO₂-e/kWh';
    const val = document.createElement('span');
    val.className = 'ms-auto tabular-nums';
    const v = state.intensityAligned[idx];
    val.textContent = v == null ? '—' : fmtMW.format(v * G_PER_KWH);
    row.append(line, name, val);
    readout.append(row);
  }

  // Overlay readout rows (LAB-1700, LAB-1699): the same relief channel the
  // fuel bands use — every hovered price/demand/weather value is reachable
  // without color. Weather only needs state.weatherAligned (set whenever a
  // variable is selected, even mid-fetch or after a failure — a null entry
  // there just reads "—", same as any other gap).
  if ((state.aligned && (state.overlays.demand || priceDrawable())) || state.weatherAligned) {
    const overlays = state.aligned;
    const theme = currentTheme();
    const addOverlayRow = (ink, label, text) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2';
      const swatch = document.createElement('span');
      // Line mark ⇒ line swatch (a short rule, not the area rect).
      swatch.className = 'inline-block h-1 w-3 shrink-0 rounded-sm';
      swatch.style.backgroundColor = ink;
      const name = document.createElement('span');
      name.className = 'truncate text-base-content/70';
      name.textContent = label;
      const val = document.createElement('span');
      val.className = 'ms-auto font-medium tabular-nums';
      val.textContent = text;
      row.append(swatch, name, val);
      readout.append(row);
    };
    const divider = document.createElement('div');
    divider.className = 'mt-2 border-t border-base-300 pt-2 space-y-1';
    readout.append(divider);
    if (overlays && priceDrawable()) {
      const v = overlays.price[idx];
      addOverlayRow(OVERLAY_INKS.price[theme], 'Spot price ($/MWh)', v == null ? '—' : dollars(v, fmtPrice));
    }
    if (overlays && state.overlays.demand) {
      const v = overlays.demand[idx];
      addOverlayRow(OVERLAY_INKS.demand[theme], 'Demand (MW)', v == null ? '—' : fmtMW.format(v));
    }
    if (state.weatherAligned) {
      const wv = state.weatherVarDef; // resolved in renderChart, not per mousemove
      const v = state.weatherAligned[idx];
      addOverlayRow(WEATHER_INK[theme], `${wv.label} (${wv.unit})`, v == null ? '—' : v.toFixed(wv.decimals));
    }
  }
}

/* Latest intensity for the selected region, straight from the intensity
 * payload rather than the aligned overlay — the stat should show the freshest
 * reading even if the two windows ever disagree at the edge. */
function renderHeroIntensity() {
  const el = $('hero-intensity');
  const coverageEl = $('hero-coverage');
  // Both ids ship statically in index.html; guard once so a missing element
  // skips the whole stat rather than half-rendering it (Kody null-check rule).
  if (!el || !coverageEl) return;
  const series = state.intensity?.series.find((s) => s.key === (state.region || 'NEM'));
  // One scan: the value and the coverage MUST come from the same bucket, or
  // the tooltip attributes a coverage figure to a reading it doesn't describe.
  const i = series ? series.values.findLastIndex((v) => v != null) : -1;
  el.textContent = i < 0 ? '—' : `${fmtMW.format(series.values[i] * G_PER_KWH)} g`;
  if (i >= 0) {
    // Coverage is part of the number's meaning, not a footnote: render it as
    // visible text (title alone is unreachable for keyboard/touch/AT users).
    const coverage = series.coverage?.[i];
    // FLOOR, never round: 99.96% coverage must not display as "100.0%".
    const pct = coverage == null ? null : (Math.floor(coverage * 1000) / 10).toFixed(1);
    coverageEl.textContent = pct == null ? '' : `${pct}% factor coverage`;
    el.title =
      `gCO₂-e per kWh, estimated. ${
        pct == null ? '' : `${pct}% of dispatched MW carried a published factor. `
      }Reads a few percent high (as-generated vs sent-out).`;
  } else {
    coverageEl.textContent = '';
    // A failed fetch is not a statement about emission factors — saying so
    // would put a false methodology claim on a public page.
    el.title =
      state.intensity === null
        ? 'Carbon intensity is unavailable right now.'
        : 'No generation with a published emission factor in this window.';
  }
}

function renderHero() {
  const { payload, ordered } = state;
  renderHeroIntensity();
  const n = payload ? payload.timestamps.length : 0;
  if (n === 0) {
    $('hero-total').textContent = '—';
    $('hero-total-label').textContent = 'Grid-scale generation, net';
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
  // The label states whether rooftop is IN this number at THIS timestamp
  // (LAB-1701): the estimate trails SCADA by ~30-60 min, so the freshest
  // bucket usually predates it — a silent understatement here would read as
  // "solar collapsed". Three honest states, one per data situation.
  const roof = rooftopOrdered();
  const roofValue = roof === null ? null : roof.values[last];
  $('hero-total-label').textContent =
    roof === null
      ? 'Grid-scale generation, net'
      : roofValue == null
        ? 'Grid-scale generation, net · rooftop est. not yet published'
        : 'Generation incl. rooftop solar (est.), net';
  $('hero-asat').textContent = `as at ${fmtTime.format(ts)} AEST · ${fmtDate.format(ts)}`;
}

/* The rooftop band (LAB-1701) joins the stack as a pseudo-series under
 * ROOFTOP_KEY: AEMO's 30-minute estimate projected onto the chart axis, null
 * (absent, never zero) wherever no estimate is published — which is always
 * the newest ~30-60 min, since the estimate trails SCADA. Appended AFTER the
 * aggregate's own series so a hypothetical future 'Rooftop solar' fuel key
 * from the API would surface as a duplicate row (visible bug) rather than
 * being silently swallowed. */
function seriesWithRooftop() {
  const base = state.payload.series;
  if (!state.showRooftop || !state.rooftop) return base;
  const values = alignRooftop(state.payload.timestamps, state.payload.resolution, state.rooftop, state.region);
  if (!values.some((v) => v != null)) return base;
  return [...base, { key: ROOFTOP_KEY, values }];
}

/** The rooftop series as rendered, or null when the band is off/absent. */
const rooftopOrdered = () => state.ordered.find((f) => f.key === ROOFTOP_KEY) ?? null;

function render() {
  state.ordered = orderSeries(seriesWithRooftop());
  $('truncated-badge').classList.toggle('hidden', !state.payload.truncated);
  renderHero();
  renderChart();
  renderReadout(null);
}


// All regions in one payload (it is 5 small series) so region switches
// re-slice client-side; refetched alongside the aggregate so the two stay on
// the same dispatch interval. MUST carry the same range query as the
// aggregate fetch: alignOverlays matches buckets by timestamp, and equal
// windows are what make the two endpoints' bucket axes equal.
const fetchDispatch = (range) => fetchJson(`/api/v2/dispatch?${rangeQuery(range)}`);

// Open-Meteo (LAB-1699), fetched client-side straight from the browser — no
// worker proxy, keyless, CORS-open. One request carries every variable, so a
// region/range change is the only thing that needs a refetch; switching
// which variable is drawn is a pure re-render (see initWeatherOverlay).
// The abort deadline is what keeps the isolation promise: .catch() isolates
// REJECTION, but a blackholed third-party origin that never settles would
// hang the load()'s Promise.all — and the fuel-mix chart with it. Our own
// API fetches carry no deadline; only the origin we don't operate gets one.
const fetchWeather = (range, region) =>
  fetchJson(weatherEndpoint(range, region, Date.now()), { signal: AbortSignal.timeout(8000) });

// Per-feed failure isolation (LAB-1700): a side-feed promise that rejects
// logs under its grep-able label and degrades to null instead of taking the
// whole load()'s Promise.all — and the fuel mix — down with it.
const soft = (label, promise) => promise.catch((err) => {
  console.error(label, err);
  return null;
});

// Monotonic token so a slow, stale region response can never overwrite the
// latest selection (or clear a newer request's busy state).
let activeLoad = 0;

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
    const wantedDispatch = overlaysWanted(); // sampled now: a toggle can land mid-flight
    const wantedWeather = state.weatherVar !== null;
    // Overlay failures are isolated: an overlay that can't load must not take
    // the fuel mix with it — each degrades to a missing overlay and logs.
    // Intensity carries no region param — the endpoint always returns every
    // region, so one cached response serves the whole selector. It MUST carry
    // the same range query as the aggregate: intensityForRegion joins the two
    // payloads strictly by timestamp, and equal windows are what make their
    // bucket axes equal (same rule as fetchDispatch below).
    const [payload, intensity, dispatch, rooftop, weather] = await Promise.all([
      fetchJson(url),
      soft('carbon-intensity load failed:', fetchJson(`/api/v2/intensity?${rangeQuery(range)}`)),
      wantedDispatch
        ? soft('dispatch overlay refresh failed:', fetchDispatch(range))
        : Promise.resolve(null),
      // Rooftop (LAB-1701) rides every load like intensity: no region param
      // (all five regions in one small payload, sliced client-side), same
      // range query so the bucket axes join by timestamp, and isolated
      // failure — a missing estimate degrades the band to absent, never
      // takes the fuel mix down and never renders zeros.
      soft('rooftop-pv load failed:', fetchJson(`/api/v2/rooftop?${rangeQuery(range)}`)),
      // Weather (LAB-1699), region-specific unlike the others above — a
      // region switch while the overlay is on refetches under this loadId.
      wantedWeather
        ? soft('weather overlay refresh failed:', fetchWeather(range, region))
        : Promise.resolve(null),
    ]);
    if (loadId !== activeLoad) return;
    state.payload = payload;
    state.intensity = intensity;
    state.rooftop = rooftop;
    // Assign only when this load's dispatch arm was real (fetched — null then
    // means failed, degrade honestly) or overlays are still off (null clears
    // any stale payload). An overlay toggled ON mid-flight fetches under this
    // same loadId; its result must not be clobbered by our null placeholder.
    if (wantedDispatch || !overlaysWanted()) state.dispatch = dispatch;
    if (wantedWeather || state.weatherVar === null) {
      state.weather = weather;
      state.weatherKey = weatherKey();
    }
    $('error-alert').classList.add('hidden');
    render();
  } catch (err) {
    if (loadId !== activeLoad) return;
    console.error('fuel-mix load failed:', err);
    showError(`Failed to load fuel mix: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (loadId === activeLoad) {
      chartEl.classList.remove('opacity-50');
      chartEl.removeAttribute('aria-busy');
      // In finally, not the success arm: a failed load must still clear a
      // stale "weather unavailable" notice sitting beside the big banner.
      updateWeatherUi();
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
  // Overlay availability depends on the region (no NEM-wide spot price), and
  // load() routes every region commit through here — one sync point.
  updateOverlayControls();
}

// Overlay toggles (LAB-1700), OFF by default. The dispatch payload is fetched
// lazily on the first toggle-on and kept fresh by load(); price is disabled
// on the NEM-wide view because there is no NEM-wide spot price.
function updateOverlayControls() {
  const price = $('overlay-price');
  price.disabled = state.region === '';
  if (price.disabled && price.checked) {
    // A disabled checkbox can't be unchecked by the user, and a checked-but-
    // undrawable price would keep refetching dispatch on every NEM load —
    // turn it off honestly; re-enable is one click after picking a region.
    price.checked = false;
    state.overlays.price = false;
  }
  price.closest('label').classList.toggle('opacity-50', price.disabled);
}

function initOverlays() {
  for (const kind of ['price', 'demand']) {
    const box = $(`overlay-${kind}`);
    box.addEventListener('change', async () => {
      state.overlays[kind] = box.checked;
      if (box.checked && !state.dispatch) {
        const loadId = activeLoad; // bail if a region switch lands mid-fetch
        try {
          const dispatch = await fetchDispatch(state.range);
          if (loadId !== activeLoad) return;
          state.dispatch = dispatch;
        } catch (err) {
          console.error('dispatch overlay load failed:', err);
          showError(`Failed to load price/demand: ${err instanceof Error ? err.message : String(err)}`);
          box.checked = false;
          state.overlays[kind] = false;
          return;
        }
      }
      renderChart();
      renderReadout(null);
    });
  }
}

// Weather overlay (LAB-1699): a non-blocking notice + reverting the select
// to "off" on failure, deliberately NOT the big fuel-mix error banner — an
// Open-Meteo outage is not our data being down, and must not read as one.
// The CC-BY attribution appears whenever the overlay has been switched on,
// regardless of whether this particular fetch succeeded.
function updateWeatherUi() {
  $('weather-note').classList.toggle('hidden', !weatherFailed());
  $('weather-attribution').classList.toggle('hidden', state.weatherVar === null);
}

function initWeatherOverlay() {
  const select = $('weather-overlay');
  select.innerHTML = '';
  select.append(new Option('Weather: off', ''));
  for (const v of WEATHER_VARS) select.append(new Option(v.label, v.key));

  select.addEventListener('change', async () => {
    state.weatherVar = select.value || null;
    // Refetch when there is no payload OR the one in hand answers a different
    // region|range — a payload stranded by a failed load() (its catch skips
    // the weather assignment while the selection has already committed) must
    // not be drawn against the newer selection. On failure the selection
    // stays put (still "Wind speed", say) and weatherFailed() drives the
    // notice — the notice replaces the drawn line, not the choice, so the
    // next load() retries automatically instead of silently falling to off.
    if (state.weatherVar && (!state.weather || state.weatherKey !== weatherKey())) {
      const loadId = activeLoad; // bail if a region/range switch lands mid-fetch
      try {
        const weather = await fetchWeather(state.range, state.region);
        if (loadId !== activeLoad) return;
        state.weather = weather;
        state.weatherKey = weatherKey();
      } catch (err) {
        console.error('weather overlay load failed:', err);
        if (loadId !== activeLoad) return;
        state.weather = null;
      }
    }
    updateWeatherUi();
    renderChart();
    renderReadout(null);
  });
}

// Theme toggle: explicit choice persists; OS changes apply only while the
// user hasn't chosen. Chart colours are canvas-baked, so re-render on switch.
function initTheme() {
  installTheme(() => {
    // Chart colours are canvas-baked, so a theme switch is a repaint.
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

// Toggling the intensity overlay is pure re-render — the payload is already in hand.
$('intensity-toggle').addEventListener('change', (e) => {
  state.showIntensity = e.target.checked;
  if (!state.payload) return;
  renderChart();
  renderReadout(null);
});

// The rooftop toggle changes the SERIES SET (band in/out of the stack), so it
// goes through render() — hero label, stack order and readout must all agree.
$('rooftop-toggle').addEventListener('change', (e) => {
  state.showRooftop = e.target.checked;
  if (!state.payload) return;
  render();
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
initOverlays();
initWeatherOverlay();
load(state.region, state.range); // renders the filters as it commits
