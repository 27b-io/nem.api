#!/usr/bin/env node
// Station geodata snapshot for the map (LAB-1702): turns Open Electricity's
// v4 facility dump into public/facilities.json — a DUID -> {lat, lng, facility
// name/code, wikipedia, website} mapping, committed to the repo like the
// generated seed migration and the built stylesheet.
//
// WHY a vendored snapshot rather than a live fetch: the dump URL is the
// backing file of OE's API, not a documented contract (its v3 predecessor
// already changed domains once), and station coordinates change about as often
// as new stations get built. A committed snapshot means a page load never
// depends on a third party being up, and a refresh is a reviewed diff instead
// of a silent overnight change.
//
// LICENCE: the dump is CC BY-NC 4.0. Attribution is rendered on the map page
// and the non-commercial clause is satisfied by nem.27b.io today; if that ever
// changes the documented fallback is Geoscience Australia's "Major Power
// Stations" (CC-BY 4.0, no DUID — name matching only). We take only what a pin
// needs: OE's own capacity and emission-factor fields are deliberately NOT
// copied, because AEMO publishes both under attribution-only terms and we
// already ingest them.
//
//   node scripts/build-facilities.mjs              fetch live, write, report
//   node scripts/build-facilities.mjs --self-check pure-core check, no network
//   node scripts/build-facilities.mjs --from f.json --generators g.json --values v.json
//
// Nothing here is exported: the build body runs at module scope, so an import
// would fetch Open Electricity and overwrite the committed snapshot as a side
// effect of reading a constant.
//
// The coverage report is the point of the exercise, not a footnote: re-run it
// on every refresh and read the unmatched list. See worker/README.md.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildSnapshot, joinStations, unitAliases } from '../public/stations.js';

const SOURCE_URL = 'https://data.openelectricity.org.au/v4/facilities/au_facilities.json';
const GENERATORS_URL = 'https://nem.27b.io/api/v2/generators';
const VALUES_URL = 'https://nem.27b.io/api/v2/values?hours=2';

const OUT_PATH = new URL('../public/facilities.json', import.meta.url);
const FIXTURE_PATH = new URL('./fixtures/oe-facilities-sample.json', import.meta.url);

// The dump carries ~540 NEM facilities. Far fewer means a truncated or
// reshaped file — abort rather than ship a map with holes in it.
const MIN_FACILITIES = 400;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  // A typed flag missing its value must abort — falling through to `undefined`
  // would silently switch the build to network mode and overwrite the snapshot.
  const value = process.argv[i + 1];
  assert.ok(value && !value.startsWith('--'), `${name} needs a file path`);
  return value;
};

async function loadJson(url, file) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch((err) => {
    throw new Error(`fetching ${url}: ${err.message} — facilities.json left untouched`, { cause: err });
  });
  assert.ok(res.ok, `HTTP ${res.status} fetching ${url} — facilities.json left untouched`);
  return res.json().catch((err) => {
    throw new Error(`parsing JSON from ${url}: ${err.message}`, { cause: err });
  });
}

// --- self-check: the pure core against a captured slice of the live dump -----
// fixtures/oe-facilities-sample.json is a genuine capture (2026-08-09) trimmed
// to six facilities chosen to exercise every hazard: a multi-DUID coal
// station, a battery whose AEMO DUID only appears as OE's synthesised
// charge/discharge pair, a hybrid solar+battery site, a facility with no
// coordinates, and a non-NEM (WEM) facility that must not leak in.

function selfCheck() {
  assert.deepEqual(unitAliases('BW01'), ['BW01'], 'a real DUID must not sprout aliases');
  assert.deepEqual(unitAliases('0BRDDBESL1'), ['0BRDDBESL1', 'BRDDBESL1', 'BRDDBES1']);
  assert.deepEqual(unitAliases('0MREHAG1'), ['0MREHAG1', 'MREHAG1', 'MREHA1']);

  const dump = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const { facilities, skipped, conflicts } = buildSnapshot(dump.data);
  assert.equal(conflicts.length, 0, 'fixture must not produce alias conflicts');
  assert.deepEqual(skipped.map((s) => s.code), ['0BOGGABRI'], 'coordinate-less facility must be skipped, loudly');
  assert.deepEqual(facilities.map((f) => f.code), ['BAYSW', 'BRDD', 'MREH', 'QP'],
    'WEM facility leaked into a NEM snapshot, or a NEM one went missing');
  assert.equal(facilities[3].duids.QPSFB2, 'alias', 'second-unit battery alias (0QPSFB{L,G}2 -> QPSFB2) broke');

  const bayswater = facilities[0];
  assert.deepEqual(Object.keys(bayswater.duids).sort(), ['BW01', 'BW02'], 'multi-DUID station lost a unit');
  assert.equal(bayswater.wikipedia, 'https://en.wikipedia.org/wiki/Bayswater_Power_Station');
  assert.equal(bayswater.website, 'https://www.agl.com.au', 'owner website not carried through');
  assert.equal(facilities[1].duids.BRDDBES1, 'alias', "battery DUID must resolve through OE's synthesised pair");
  assert.equal(facilities[1].duids.BRDDSF01, 'exact', 'co-located solar must still match exactly');

  // Runtime join: region disagreement is refused, unknown DUIDs are listed,
  // non-market ('-') units are simply not this map's business.
  const joined = joinStations({ facilities }, [
    { duid: 'BW01', name: 'Bayswater', state: 'NSW1', fuel_type: 'Fossil', reg_cap: 660 },
    { duid: 'BW02', name: 'Bayswater', state: 'NSW1', fuel_type: 'Fossil', reg_cap: 660 },
    { duid: 'BRDDBES1', name: 'Broadsound', state: 'QLD1', fuel_type: 'Battery Storage', reg_cap: 100 },
    { duid: 'BRDDSF01', name: 'Broadsound Solar', state: 'QLD1', fuel_type: 'Solar', reg_cap: 150 },
    { duid: 'MREHA1', name: 'Melbourne A1', state: 'NSW1', fuel_type: 'Battery Storage', reg_cap: 50 },
    { duid: 'NOSUCH1', name: 'Nowhere', state: 'SA1', fuel_type: 'Wind', reg_cap: 10 },
    { duid: '-', name: 'Non-market unit', state: 'VIC1', fuel_type: 'Fossil', reg_cap: 5 },
  ]);
  assert.deepEqual(joined.unmatched.map((u) => u.duid), ['NOSUCH1'], 'unknown DUID must surface, not vanish');
  assert.deepEqual(joined.regionMismatch.map((m) => m.duid), ['MREHA1'],
    'a unit AEMO and the snapshot place in different regions must NOT be pinned');
  assert.deepEqual(joined.stations.map((s) => [s.code, s.units.length, s.capacity, s.fuel]), [
    ['BAYSW', 2, 1320, 'Fossil'],
    ['BRDD', 2, 250, 'Solar'], // hybrid site: coloured by the larger capacity
  ]);
}

selfCheck();

if (process.argv.includes('--self-check')) {
  console.log('self-check passed (snapshot build + DUID join verified against the captured dump sample)');
  process.exit(0);
}

// --- build -------------------------------------------------------------------

const dump = await loadJson(SOURCE_URL, arg('--from'));
assert.ok(Array.isArray(dump.data), 'dump has no `data` array — Open Electricity reshaped the file');

const { facilities, skipped, conflicts } = buildSnapshot(dump.data);
assert.equal(
  conflicts.length,
  0,
  `alias conflicts — refusing to ship an ambiguous map:\n${conflicts.map((c) => JSON.stringify(c)).join('\n')}`,
);
assert.ok(
  facilities.length >= MIN_FACILITIES,
  `only ${facilities.length} NEM facilities with coordinates (< ${MIN_FACILITIES}) — dump looks truncated`,
);

writeFileSync(
  OUT_PATH,
  `${JSON.stringify({
    _generated_by: 'scripts/build-facilities.mjs — do not hand-edit',
    source: SOURCE_URL,
    license: 'Facility data © Open Electricity, CC BY-NC 4.0 (https://docs.openelectricity.org.au/introduction/)',
    captured: new Date().toISOString().slice(0, 10),
    facilities,
  })}\n`,
);
console.log(`Wrote public/facilities.json — ${facilities.length} NEM facilities, ${skipped.length} skipped for missing coordinates`);

// --- coverage report ---------------------------------------------------------

const generators = await loadJson(GENERATORS_URL, arg('--generators'));
const { stations, unmatched, regionMismatch } = joinStations({ facilities }, generators);
const joinable = generators.filter((g) => g.duid && g.duid !== '-').length;
// The coverage report is the point of the run — an empty or reshaped
// generators payload would print NaN% on every line, which reads as success.
assert.ok(joinable > 0, 'no joinable DUIDs in the generators payload — coverage report would be meaningless');
const pct = (n) => `${((n / joinable) * 100).toFixed(1)}%`;

console.log(`\nJoin coverage vs /api/v2/generators (${joinable} DUIDs):`);
console.log(`  pinned      ${joinable - unmatched.length - regionMismatch.length} (${pct(joinable - unmatched.length - regionMismatch.length)}) across ${stations.length} stations`);
console.log(`  unmatched   ${unmatched.length} (${pct(unmatched.length)})`);
console.log(`  region clash ${regionMismatch.length}`);
for (const m of regionMismatch) console.log(`    ! ${m.duid}: AEMO says ${m.ours}, snapshot says ${m.snapshot} (${m.facility})`);

// Registration lists units that have not started dispatching (and ones that
// stopped); the number that matters for a live map is the DUIDs actually
// reporting SCADA now. Best-effort — a probe failure must not fail a build
// whose artifact is already written and valid.
try {
  const values = await loadJson(VALUES_URL, arg('--values'));
  const active = new Set(values.series.filter((s) => s.values.some((v) => v != null)).map((s) => s.duid));
  const activeUnmatched = unmatched.filter((u) => active.has(u.duid));
  console.log(`\n  of ${active.size} DUIDs dispatching in the last 2 h: ${active.size - activeUnmatched.length} pinned (${((1 - activeUnmatched.length / active.size) * 100).toFixed(1)}%)`);
  console.log(`  unmatched and dispatching (these are the ones that matter):`);
  for (const u of activeUnmatched) console.log(`    - ${u.duid.padEnd(11)} ${u.state.padEnd(5)} ${u.fuel_type ?? ''} — ${u.name}`);
} catch (err) {
  console.log(`\n  (live-activity probe skipped: ${err.message})`);
}

console.log(`\n  unmatched, all (incl. not currently dispatching):`);
for (const u of unmatched) console.log(`    - ${u.duid.padEnd(11)} ${u.state.padEnd(5)} ${u.fuel_type ?? ''} — ${u.name}`);
