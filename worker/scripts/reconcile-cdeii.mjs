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
if (!Number.isFinite(DAYS) || DAYS <= 0) {
  // Catch `--days` as the last argument (undefined → NaN) and `--days abc`
  // here as a usage error, not downstream as an opaque HTTP 400.
  console.error('--days must be a positive number');
  process.exit(2);
}

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
let res;
try {
  // A hung or unreachable endpoint is a gate failure, not a hang: bound the
  // request and turn transport errors into the same exit-code-2 diagnostic.
  res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
} catch (err) {
  console.error(`fetch failed for ${url}: ${err.cause?.message ?? err.message}`);
  process.exit(2);
}
if (!res.ok) {
  console.error(`HTTP ${res.status} fetching ${url}`);
  process.exit(2);
}
const body = await res.json();
if (body.series?.[0]?.official === undefined) {
  // The field is present on every daily response, so its absence means the
  // response was not daily — not that cdeii_daily is empty (that shows up as
  // a column of nulls and is caught by the compared === 0 gate below).
  console.error(`expected a daily response, got resolution=${body.resolution} — widen --days`);
  process.exit(2);
}

const day = (ts) => new Date(ts * 1000 - 86400_000).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });

let compared = 0;
let failed = 0;
console.log(`Reconciling ${BASE} against AEMO's official CDEII index (rtol ${RTOL}, atol ${ATOL})\n`);
console.log('date        region  ours     official  delta     coverage');

for (const series of body.series) {
  if (!Array.isArray(series.official)) {
    // The top-of-script guard only proved series[0] is daily-shaped; a
    // partial/degraded response must still die as a diagnostic, not a
    // TypeError three lines down.
    console.error(`series ${series.key} has no official array — response is not daily`);
    process.exit(2);
  }
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
