#!/usr/bin/env node
// Reconciliation harness (LAB-1698): is our computed carbon intensity still
// honest against AEMO's official daily index?
//
// /api/v2/intensity at resolution=86400 returns both numbers per region-day —
// our energy-weighted estimate in `values`, AEMO's published index in
// `official` — so this is a fetch and a comparison, not a re-implementation.
// Run it after any change to the factor join, the bucket math, or the CDEII
// refresh; a widening delta means the estimate has drifted from the thing it
// claims to approximate.
//
//   node scripts/reconcile-cdeii.mjs [--base https://nem.27b.io] [--days 7]
//
// Exits non-zero when any region-day misses the tolerance, so CI or a cron can
// use it as a gate.

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const BASE = arg('base', 'https://nem.27b.io');
const DAYS = Number(arg('days', 7));

// Tolerance is relative OR absolute, whichever is kinder — the numpy
// allclose shape. A pure relative gate is meaningless where the official
// index is near zero: on 2026-07-01 SA1 read 0.0105 tCO2-e/MWh, so a 0.0019
// absolute difference (a rounding crumb on a near-100%-renewable day) scores
// as 18%. ATOL is set at roughly 4 g CO2-e/kWh, below which nobody can act on
// the difference anyway.
const RTOL = 0.1;
const ATOL = 0.02;

const url =
  `${BASE}/api/v2/intensity?days=${DAYS}&resolution=86400`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`HTTP ${res.status} fetching ${url}`);
  process.exit(2);
}
const body = await res.json();
if (!body.series?.[0]?.official) {
  console.error('no `official` field in the response — is cdeii_daily populated? (run the CDEII refresh)');
  process.exit(2);
}

const day = (ts) => new Date(ts * 1000 - 86400_000).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });

let compared = 0;
let failed = 0;
console.log(`Reconciling ${BASE} against AEMO's official CDEII index (rtol ${RTOL}, atol ${ATOL})\n`);
console.log('date        region  ours     official  delta     coverage');

for (const series of body.series) {
  for (let i = 0; i < body.timestamps.length; i++) {
    const ours = series.values[i];
    const official = series.official[i];
    if (ours === null || official === null) continue;
    compared++;
    const abs = Math.abs(ours - official);
    const ok = abs <= ATOL || abs / official <= RTOL;
    if (!ok) failed++;
    const rel = official === 0 ? '     n/a' : `${(((ours - official) / official) * 100).toFixed(1).padStart(7)}%`;
    const coverage = series.coverage[i] === null ? '   n/a' : `${(series.coverage[i] * 100).toFixed(1)}%`;
    console.log(
      `${day(body.timestamps[i])}  ${series.key.padEnd(6)}  ${ours.toFixed(4)}   ${official.toFixed(4)}    ` +
        `${rel}   ${coverage.padStart(6)}  ${ok ? '' : '  <-- OUT OF TOLERANCE'}`,
    );
  }
}

console.log(`\n${compared - failed}/${compared} region-days within tolerance.`);
if (compared === 0) {
  // A gate that greenlights having checked nothing is worse than no gate.
  // Usually this means the window is more recent than AEMO's last weekly
  // publication — widen --days until it overlaps.
  console.error('nothing to compare: no region-day had BOTH an estimate and an official value in this window.');
  process.exit(1);
}
if (failed > 0) {
  console.error(`${failed} region-day(s) outside tolerance — diagnose before shipping a change to the intensity math.`);
  process.exit(1);
}
