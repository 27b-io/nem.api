/* Pure fuel-mix stacking logic for the LAB-419 dashboard — no DOM, no uPlot,
 * so test/stacking.spec.ts can exercise it directly. See app.js for the
 * palette derivation notes (dataviz six-checks validator, both themes).
 *
 * Values are NET MW (worker/API.md): a fuel band can go negative (batteries
 * charging, station load). Stacking is therefore diverging: each fuel is
 * split into a positive and a negative half, each half cumulated within its
 * own sign group, so positives stack up from zero and negatives stack down —
 * per-interval correct even when a series flips sign mid-window. Band/dir
 * semantics follow uPlot's stacked-series demo (MIT, leeoniya/uPlot):
 * band.series = [fill owner, its inner neighbour], dir -1 fills toward
 * scale.min (positive group), dir 1 toward scale.max (negative group).
 */

export const FUEL_SLOTS = [
  { key: 'Fossil',    label: 'Fossil',            light: '#8f5115', dark: '#8f4d0f' },
  { key: 'Fuel Oil',  label: 'Fuel oil',          light: '#f35020', dark: '#f4531f' },
  { key: 'Renewable', label: 'Renewable (other)', light: '#1f9e8e', dark: '#21a696' },
  { key: 'Biomass',   label: 'Biomass',           light: '#66701f', dark: '#75801a' },
  { key: 'Hydro',     label: 'Hydro',             light: '#2f7ec7', dark: '#4a94dd' },
  { key: 'Wind',      label: 'Wind',              light: '#2e7031', dark: '#34803c' },
  { key: 'Solar',     label: 'Solar',             light: '#eda100', dark: '#c98500' },
  // Rooftop solar (LAB-1701): NOT an aggregate fuel key — app.js appends a
  // pseudo-series under ROOFTOP_KEY from /api/v2/rooftop (AEMO's 30-minute
  // estimate). Adjacent to Solar by design; the darker gold is the
  // protanopia-safe lightness step against Solar's bright yellow, re-run
  // through the six-checks validator with the full stack on both surfaces
  // (2026-08-09): zero new deviations vs the shipped baseline.
  { key: 'Rooftop solar', label: 'Rooftop solar (est.)', light: '#b87d00', dark: '#9c6d00' },
];

/** The pseudo-series key app.js injects for the rooftop band. */
export const ROOFTOP_KEY = 'Rooftop solar';

// The 2015 seed has no batteries; the LAB-421 registration refresh will add
// them with an AEMO key like "Battery storage" — match loosely so they land
// in the reserved violet slot (validated top-of-stack) the day they appear.
const BATTERY = { light: '#4a3aa7', dark: '#9085e9' };

// Fold bucket for "" (NULL fuel on a mapped generator, per contract) and any
// key this palette doesn't know. Lightness-stepped grays so two unknowns
// stay tellable-apart; identity is carried by the readout, not the hue.
const OTHER_GRAYS = [
  { light: '#8b8b85', dark: '#8b8b85' },
  { light: '#6d6d66', dark: '#a7a79f' },
  { light: '#a7a79f', dark: '#6d6d66' },
];

/* Map the payload's series onto palette slots in fixed stack order.
 * Unknown keys keep their own series and label — they fold into gray, they
 * are never dropped and never silently merged. */
export function orderSeries(series) {
  let grays = 0;
  return series
    .map((s) => {
      const slot = FUEL_SLOTS.findIndex((f) => f.key === s.key);
      if (slot !== -1) return { ...FUEL_SLOTS[slot], values: s.values, rank: slot };
      if (/battery|bess/i.test(s.key)) {
        return { key: s.key, label: s.key, ...BATTERY, values: s.values, rank: FUEL_SLOTS.length };
      }
      const gray = OTHER_GRAYS[Math.min(grays, OTHER_GRAYS.length - 1)];
      grays += 1;
      return {
        key: s.key,
        label: s.key === '' ? 'Unspecified' : s.key,
        ...gray,
        values: s.values,
        rank: FUEL_SLOTS.length + 1 + grays,
      };
    })
    .sort((a, b) => a.rank - b.rank);
}

/* Diverging stack: positive halves cumulate up, negative halves cumulate
 * down, per interval. null (no sample in bucket) contributes 0 to geometry;
 * the readout reports it as "—" from the raw values. Returns uPlot inputs:
 * data (x + cumulative tops), per-series opts, and bands. */
export function buildStack(ordered, theme, surfaceColor, timestamps) {
  const nBuckets = timestamps.length;
  const data = [timestamps];
  const seriesOpts = [{}];
  const bands = [];
  const groups = [
    { sign: 1, dir: -1, prevIdx: 0, acc: new Array(nBuckets).fill(0) },
    { sign: -1, dir: 1, prevIdx: 0, acc: new Array(nBuckets).fill(0) },
  ];

  for (const fuel of ordered) {
    for (const g of groups) {
      if (!fuel.values.some((v) => v != null && v * g.sign > 0)) continue;
      const tops = fuel.values.map((v, i) => {
        const half = v != null && v * g.sign > 0 ? v : 0;
        return (g.acc[i] += half);
      });
      data.push(tops);
      seriesOpts.push({
        label: fuel.label,
        stroke: surfaceColor, // 1px surface-colour separator between bands
        width: 1,
        fill: fuel[theme],
        points: { show: false },
      });
      const idx = data.length - 1;
      // Fill toward zero stops at the previous band in this group; the first
      // band in each group fills to the zero baseline natively (uPlot
      // seriesFillTo returns 0 for a series that owns no band).
      if (g.prevIdx !== 0) bands.push({ series: [idx, g.prevIdx], dir: g.dir });
      g.prevIdx = idx;
    }
  }
  return { data, seriesOpts, bands };
}
