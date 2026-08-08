// Reconciliation harness (LAB-1698 acceptance gate): compute daily regional
// carbon intensity from the production API's raw SCADA values x AEMO's live
// CDEII emission factors, and compare it against AEMO's official daily
// CO2E_INTENSITY_INDEX — per region + NEM, for a set of sample days.
//
// This is the honesty check on /api/v2/intensity's methodology: the tolerance
// (default ±10%) bounds the known as-generated vs sent-out bias plus
// auxiliary-load variance. Near-zero official days (hydro/wind regions like
// TAS) use an absolute tolerance instead — a relative check against ~0 is
// meaningless.
//
// Both computation grains are reported:
//   raw    — 5-minute samples, value > 0 (what resolution 300/1800 serves)
//   daily  — per-generator daily NET sum, sum > 0 (what resolution 86400
//            serves from scada_daily; sign test at bucket grain)
//
// Usage:
//   node scripts/reconcile-intensity.mjs [--days 2026-07-29,2026-07-30,...]
//     [--api https://nem.27b.io] [--tolerance 0.10] [--self-check]
//
// Exit code 0 = every (day, region) within tolerance; 1 otherwise.

const CDEII = 'https://nemweb.com.au/Reports/Current/CDEII/';
const NEM_OFFSET = 36000; // AEST, UTC+10, no DST
const ABS_TOLERANCE = 0.01; // tCO2-e/MWh, for official values below ABS_CUTOFF
const ABS_CUTOFF = 0.05;

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const API = argOf('--api', 'https://nem.27b.io');
const TOLERANCE = Number(argOf('--tolerance', '0.10'));
const DAYS = argOf('--days', '2026-07-29,2026-07-30,2026-07-31').split(',');

/** RFC-4180-ish split (mirror of src/emissions.ts splitCsvLine). */
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { fields.push(cur); cur = ''; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

/** AEMO CO2EII CSV -> name-addressed records (columns from the I row). */
function parseCdeii(text) {
  let header = null;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('I,CO2EII,')) header = splitCsvLine(line);
    else if (line.startsWith('D,CO2EII,') && header) {
      const f = splitCsvLine(line);
      rows.push(Object.fromEntries(header.map((h, i) => [h, f[i] ?? ''])));
    }
  }
  return rows;
}

/**
 * Core math, pure for --self-check: per-region {raw, daily} intensity from
 * per-generator daily sample arrays.
 * gens: [{ region, factor|null, values: (number|null)[] }]
 */
function computeIntensity(gens) {
  const acc = new Map(); // region -> {mw,mwF,em, dMw,dMwF,dEm}
  const get = (r) => acc.get(r) ?? acc.set(r, { mw: 0, mwF: 0, em: 0, dMw: 0, dMwF: 0, dEm: 0 }).get(r);
  for (const g of gens) {
    let net = 0;
    for (const v of g.values) {
      if (v == null) continue;
      net += v;
      if (v > 0) {
        for (const a of [get(g.region), get('NEM')]) {
          a.mw += v;
          if (g.factor !== null) { a.mwF += v; a.em += v * g.factor; }
        }
      }
    }
    if (net > 0) {
      for (const a of [get(g.region), get('NEM')]) {
        a.dMw += net;
        if (g.factor !== null) { a.dMwF += net; a.dEm += net * g.factor; }
      }
    }
  }
  const out = {};
  for (const [region, a] of acc) {
    out[region] = {
      raw: a.mwF > 0 ? a.em / a.mwF : null,
      daily: a.dMwF > 0 ? a.dEm / a.dMwF : null,
      coverage: a.mw > 0 ? a.mwF / a.mw : null,
    };
  }
  return out;
}

function selfCheck() {
  // Two regions; B includes a net-negative battery day the daily grain must drop.
  const out = computeIntensity([
    { region: 'A1', factor: 1.0, values: [100, 100] },
    { region: 'A1', factor: 0.5, values: [100, 100] },
    { region: 'A1', factor: null, values: [50, null] },
    { region: 'B1', factor: 0, values: [10, -20] }, // net -10: raw keeps the +10 sample, daily drops it
  ]);
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  if (!close(out.A1.raw, 0.75) || !close(out.A1.daily, 0.75)) throw new Error(`A1 wrong: ${JSON.stringify(out.A1)}`);
  if (!close(out.A1.coverage, 400 / 450)) throw new Error(`A1 coverage wrong: ${out.A1.coverage}`);
  if (!close(out.B1.raw, 0) || out.B1.daily !== null) throw new Error(`B1 wrong: ${JSON.stringify(out.B1)}`);
  if (!close(out.NEM.raw, 300 / 410)) throw new Error(`NEM raw wrong: ${out.NEM.raw}`);
  console.log('self-check passed');
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function main() {
  if (args.includes('--self-check')) return selfCheck();

  // Per-DUID factors (AVG across genset rows, mirroring the API's join).
  const byDuid = new Map();
  for (const r of parseCdeii(await fetchText(CDEII + 'CO2EII_AVAILABLE_GENERATORS.CSV'))) {
    const f = Number(r.CO2E_EMISSIONS_FACTOR);
    if (r.DUID && Number.isFinite(f)) {
      const cur = byDuid.get(r.DUID) ?? [];
      cur.push(f);
      byDuid.set(r.DUID, cur);
    }
  }
  const factorOf = (duid) => {
    const fs = byDuid.get(duid);
    return fs ? fs.reduce((a, b) => a + b, 0) / fs.length : null;
  };

  // Official daily index rows, keyed "<YYYY-MM-DD>|<region>".
  const official = new Map();
  for (const r of parseCdeii(await fetchText(CDEII + 'CO2EII_SUMMARY_RESULTS.CSV'))) {
    const day = r.SETTLEMENTDATE?.slice(0, 10).replaceAll('/', '-');
    if (day) official.set(`${day}|${r.REGIONID}`, Number(r.CO2E_INTENSITY_INDEX));
  }

  const genRows = await fetchJson(`${API}/api/v2/generators`);
  if (!Array.isArray(genRows)) throw new Error(`generators: expected an array, got ${JSON.stringify(genRows)?.slice(0, 200)}`);
  const regionOf = new Map(genRows.map((g) => [g.duid, g.state]));

  // One fetch per sample day, issued in parallel; verdicts print in DAYS order.
  const payloads = await Promise.all(
    DAYS.map(async (day) => {
      // Day D covers period-ENDING settlements (D 00:05 .. D+1 00:00] AEST.
      const startUnix = Date.parse(`${day}T00:00:00+10:00`) / 1000;
      const payload = await fetchJson(`${API}/api/v2/values?time_start=${startUnix + 300}&time_end=${startUnix + 86400}&resolution=300`);
      if (!Array.isArray(payload?.series)) throw new Error(`${day}: values: expected a series array in the response`);
      return payload;
    }),
  );

  let failures = 0;
  const unfactored = new Map(); // duid -> peak MW seen, for the disclosure list
  for (const [di, day] of DAYS.entries()) {
    const payload = payloads[di];
    if (payload.truncated) throw new Error(`${day}: response truncated — narrow the window`);

    const gens = payload.series.map((s) => ({
      region: regionOf.get(s.duid) ?? 'UNKNOWN',
      factor: factorOf(s.duid),
      values: s.values,
    }));
    for (const s of payload.series) {
      if (factorOf(s.duid) === null) {
        const peak = Math.max(0, ...s.values.filter((v) => v != null));
        unfactored.set(s.duid, Math.max(unfactored.get(s.duid) ?? 0, peak));
      }
    }
    const ours = computeIntensity(gens);

    console.log(`\n=== ${day} (${payload.timestamps.length} intervals, ${payload.series.length} DUIDs) ===`);
    console.log('region  ours-raw  ours-daily  official     Δraw     verdict');
    for (const region of ['NEM', 'NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1']) {
      const o = ours[region];
      const ref = official.get(`${day}|${region}`);
      if (o === undefined || ref === undefined) {
        console.log(`${region.padEnd(7)} MISSING (ours=${JSON.stringify(o)}, official=${ref})`);
        failures++;
        continue;
      }
      // computeIntensity returns null raw/daily/coverage for a region whose
      // generation carried no published factor — that's a verdict (FAIL,
      // nothing to compare), not a crash.
      const fmt = (v, digits) => (v === null ? 'n/a' : v.toFixed(digits));
      const delta = o.raw === null ? null : o.raw - ref;
      const rel = delta !== null && ref !== 0 ? delta / ref : null;
      // On the relative branch ref >= ABS_CUTOFF > 0, so rel is never null there.
      const pass =
        delta !== null && (ref < ABS_CUTOFF ? Math.abs(delta) <= ABS_TOLERANCE : Math.abs(rel) <= TOLERANCE);
      if (!pass) failures++;
      const dShow =
        delta === null
          ? 'n/a'
          : ref < ABS_CUTOFF
            ? `${delta >= 0 ? '+' : ''}${delta.toFixed(4)} abs`
            : `${rel >= 0 ? '+' : ''}${(rel * 100).toFixed(1)}%`;
      console.log(
        `${region.padEnd(7)} ${fmt(o.raw, 4)}    ${fmt(o.daily, 4)}      ${ref.toFixed(4)}    ${dShow.padStart(9)}  ${pass ? 'PASS' : 'FAIL'}` +
          (region === 'NEM' ? `  (coverage ${fmt(o.coverage === null ? null : o.coverage * 100, 2)}%)` : ''),
      );
    }
  }

  if (unfactored.size > 0) {
    console.log(`\nDUIDs generating without a published factor (excluded from ratio, disclosed):`);
    for (const [duid, peak] of [...unfactored].sort()) console.log(`  ${duid} (peak ${peak.toFixed(1)} MW)`);
  }
  console.log(failures === 0 ? '\nRECONCILIATION PASS' : `\nRECONCILIATION FAIL (${failures} region-day(s) out of tolerance)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
