#!/usr/bin/env node
// Live generator-registration refresh (LAB-421): fetches AEMO's "NEM
// Registration and Exemption List" workbook, maps the "PU and Scheduled
// Loads" sheet to the `generators` schema, and writes refresh-upsert.sql —
// idempotent `INSERT ... ON CONFLICT(duid, name) DO UPDATE` statements that
// `wrangler d1 execute` applies (see .github/workflows/refresh-generators.yml).
//
// Fail-safe by construction: every anomaly (fetch failure, renamed sheet,
// renamed/removed column, suspiciously small list) aborts via assert BEFORE
// any SQL is written, and the SQL itself contains no DELETE — existing rows
// keep their ids (scada_values references them) and rows missing from the
// new registration are simply left in place.
//
// The workbook is served with a .xls name but is actually OOXML (.xlsx =
// zip + XML), so fflate (already a Worker dependency) plus the minimal cell
// extraction below replaces a spreadsheet library. If AEMO ever reverts to
// real binary .xls, the zip magic check fails loudly.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { resolveColumns, collapseGenerators, sqlTuple, GENERATOR_COLUMNS } from './registration.mjs';

export const WORKBOOK_URL =
  'https://www.aemo.com.au/-/media/Files/Electricity/NEM/Participant_Information/NEM-Registration-and-Exemption-List.xls';
export const SHEET_NAME = 'PU and Scheduled Loads';

const OUT_PATH = new URL('../refresh-upsert.sql', import.meta.url);
const FIXTURE_PATH = new URL('./fixtures/nem-registration-sample.xlsx', import.meta.url);

// AEMO's WAF 403s non-browser user agents (verified live 2026-07-24).
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

// The live sheet has ~575 generators (the 2015 seed had 350). Far fewer means
// a truncated or mangled workbook — abort rather than upsert garbage.
const MIN_GENERATORS = 400;

// Column headers as published in the live workbook. These DRIFTED from the
// 2015 CSV ('Reg Cap (MW)' -> 'Reg Cap generation (MW)', consumption/storage
// columns added for bidirectional units); resolveColumns turns the next drift
// into a loud failure instead of silently shifted data.
const COLUMNS = {
  participant: 'Participant',
  name: 'Station Name',
  state: 'Region',
  fuel_type: 'Fuel Source - Primary',
  fuel_description: 'Fuel Source - Descriptor',
  technology_type: 'Technology Type - Primary',
  technology_description: 'Technology Type - Descriptor',
  duid: 'DUID',
  reg_cap: 'Reg Cap generation (MW)',
  max_cap: 'Max Cap generation (MW)',
};

// --- minimal OOXML worksheet reader -----------------------------------------
// Handles exactly what AEMO's machine-generated workbook uses: shared strings,
// inline strings, plain values, sparse rows. Regex over machine-emitted XML is
// fine here because every anomaly path ends in an assert, not silent data.

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      return String.fromCodePoint(parseInt(e[1] === 'x' ? e.slice(2) : e.slice(1), e[1] === 'x' ? 16 : 10));
    }
    assert.notEqual(XML_ENTITIES[e], undefined, `unknown XML entity ${m}`);
    return XML_ENTITIES[e];
  });
}

// 'A' -> 0, 'Z' -> 25, 'AA' -> 26
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Concatenated text of all <t> runs in an XML fragment. */
const tText = (xml) => [...xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

const attr = (attrs, name) => (attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`)) || [])[1];

/**
 * Parse one worksheet into rows of string cell values (dense arrays, missing
 * cells = ''). Numbers stay strings — collapseGenerators does the Number().
 */
function parseSheetRows(sheetXml, sharedStrings) {
  const rows = [];
  for (const [, rowXml] of sheetXml.matchAll(/<row [^>]*>(.*?)<\/row>/gs)) {
    const cells = [];
    for (const [, ref, attrs, body = ''] of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const type = attr(attrs, 't');
      let value = '';
      if (type === 'inlineStr') {
        value = tText(body);
      } else {
        const v = body.match(/<v[^>]*>([^<]*)<\/v>/);
        if (v) {
          value = type === 's' ? sharedStrings[Number(v[1])] : decodeXml(v[1]);
          assert.notEqual(value, undefined, `shared string index ${v[1]} out of range`);
        }
      }
      cells[colIndex(ref)] = value;
    }
    rows.push(cells);
  }
  const width = rows.length > 0 ? rows[0].length : 0;
  return rows.map((r) => Array.from({ length: Math.max(width, r.length) }, (_, i) => r[i] ?? ''));
}

/** Extract the named sheet from an OOXML workbook as rows of strings. */
export function readSheetRows(zipBytes, sheetName) {
  assert.ok(zipBytes[0] === 0x50 && zipBytes[1] === 0x4b,
    'workbook is not a zip (OOXML) file — AEMO reverted to binary .xls?');
  const entries = unzipSync(zipBytes);
  const text = (name) => {
    assert.ok(entries[name], `workbook has no ${name} entry`);
    return new TextDecoder().decode(entries[name]);
  };

  // workbook.xml: sheet name -> relationship id
  let relId;
  for (const [, attrs] of text('xl/workbook.xml').matchAll(/<sheet ([^>]*?)\/?>/g)) {
    if (decodeXml(attr(attrs, 'name') ?? '') === sheetName) relId = attr(attrs, 'r:id');
  }
  assert.ok(relId, `sheet "${sheetName}" not found in workbook — AEMO renamed it again?`);

  // workbook.xml.rels: relationship id -> worksheet part
  let target;
  for (const [, attrs] of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship ([^>]*?)\/?>/g)) {
    if (attr(attrs, 'Id') === relId) target = attr(attrs, 'Target');
  }
  assert.ok(target, `no relationship for sheet "${sheetName}"`);
  const part = target.startsWith('/') ? target.slice(1) : `xl/${target}`;

  const sharedStrings = entries['xl/sharedStrings.xml']
    ? [...text('xl/sharedStrings.xml').matchAll(/<si>(.*?)<\/si>/gs)].map(([, si]) => tText(si))
    : [];
  return parseSheetRows(text(part), sharedStrings);
}

// --- refresh -----------------------------------------------------------------

/** Rows -> generators via the shared collapse; asserts on header drift. */
export function mapWorkbook(zipBytes) {
  const rows = readSheetRows(zipBytes, SHEET_NAME);
  assert.ok(rows.length > 1, `sheet "${SHEET_NAME}" has no data rows`);
  const col = resolveColumns(rows[0], COLUMNS);
  return collapseGenerators(rows.slice(1), col);
}

/**
 * Idempotent upsert keyed on the (duid, name) identity (unique index
 * generators_duid_name): existing rows keep their id (scada_values points at
 * it), new registrations insert. Deliberately no DELETE — see header comment.
 */
export function buildUpsertSql(generators) {
  const update = GENERATOR_COLUMNS.split(',')
    .filter((c) => c !== 'duid' && c !== 'name')
    .map((c) => `${c}=excluded.${c}`)
    .join(',');
  const values = generators.map(sqlTuple);
  const batches = [];
  for (let i = 0; i < values.length; i += 50) {
    batches.push(
      `INSERT INTO generators (${GENERATOR_COLUMNS}) VALUES\n${values.slice(i, i + 50).join(',\n')}\n`
      + `ON CONFLICT(duid, name) DO UPDATE SET ${update};`,
    );
  }
  return `-- GENERATED by scripts/refresh-generators.mjs — do not edit or commit.\n${batches.join('\n')}\n`;
}

// --- self-check: full pipeline against a captured sample of the live sheet ---
// fixtures/nem-registration-sample.xlsx is a genuine capture (2026-07-24) of
// the workbook's XML, trimmed to 8 data rows chosen to exercise every mapping
// hazard: a bidirectional battery with the new consumption columns, sparse
// rows with omitted trailing cells, a duplicate (name, '-') pair needing
// capacity summing with '-' skips, and an XML-entity participant name.

function selfCheck() {
  assert.deepEqual([colIndex('A'), colIndex('Z'), colIndex('AA')], [0, 25, 26], 'column index math broke');
  assert.equal(decodeXml('W.H. Heck &amp; Sons &#8211; &#x41;'), 'W.H. Heck & Sons – A', 'XML entity decoding broke');

  const fixture = readFileSync(FIXTURE_PATH);
  const rows = readSheetRows(fixture, SHEET_NAME);
  assert.equal(rows.length, 9, 'fixture must parse to header + 8 data rows');
  assert.throws(() => readSheetRows(fixture, 'Generators and Scheduled Loads'),
    /not found in workbook/, 'renamed sheet must be fatal');
  assert.throws(() => resolveColumns(rows[0].map((h) => (h === 'DUID' ? 'Unit ID' : h)), COLUMNS),
    /missing required column: "DUID"/, 'renamed column must be fatal');

  const generators = mapWorkbook(fixture);
  assert.equal(generators.length, 7, 'fixture must collapse 8 unit rows to 7 generators');
  const byKey = new Map(generators.map((g) => [`${g.name}/${g.duid}`, g]));

  // Bidirectional battery: generation capacities land in reg/max_cap, the new
  // consumption/storage columns are ignored.
  assert.deepEqual(byKey.get('Adelaide Desalination Plant/ADPBA1'), {
    name: 'Adelaide Desalination Plant',
    participant_name: 'South Australian Water Corporation',
    duid: 'ADPBA1',
    state: 'SA1',
    technology_type: 'Storage',
    technology_description: 'Battery and Inverter',
    fuel_type: 'Battery Storage',
    fuel_description: 'Grid',
    reg_cap: 7.76,
    max_cap: 6.15,
  }, 'bidirectional-unit mapping broke');

  // Sparse row (workbook omits empty trailing cells entirely).
  assert.deepEqual(byKey.get('Adelaide Desalination Plant/ADPMH1'), {
    name: 'Adelaide Desalination Plant',
    participant_name: 'South Australian Water Corporation',
    duid: 'ADPMH1',
    state: 'SA1',
    technology_type: 'Renewable',
    technology_description: 'Run of River',
    fuel_type: 'Hydro',
    fuel_description: 'Water',
    reg_cap: 1.44,
    max_cap: 1,
  }, 'sparse-row mapping broke');

  // Two unit rows, same (name, '-') key: capacities sum, '-' values skipped.
  const pioneer = byKey.get('Pioneer Sugar Mill/-');
  assert.equal(pioneer.reg_cap, 67.78, "duplicate-row collapse or '-' skip broke (reg_cap)");
  assert.equal(pioneer.max_cap, 68, "duplicate-row collapse or '-' skip broke (max_cap)");

  // &amp; in the shared string must decode.
  assert.equal(byKey.get('Rocky Point Cogeneration Plant/RPCG').participant_name,
    'W.H. Heck & Sons Proprietary Limited', 'XML entity in participant name broke');

  const sql = buildUpsertSql(generators);
  assert.match(sql, /ON CONFLICT\(duid, name\) DO UPDATE SET participant_name=excluded\.participant_name/,
    'upsert must key on (duid, name)');
  assert.doesNotMatch(sql, /DELETE/i, 'refresh SQL must never delete');
  assert.match(sql, /'W\.H\. Heck & Sons Proprietary Limited'/, 'tuple generation broke');
}

selfCheck();

if (process.argv.includes('--self-check')) {
  console.log('self-check passed (column mapping verified against the captured sheet sample)');
  process.exit(0);
}

const res = await fetch(WORKBOOK_URL, { headers: { 'user-agent': USER_AGENT } });
assert.ok(res.ok, `HTTP ${res.status} fetching registration workbook — generators table left untouched`);
const workbook = new Uint8Array(await res.arrayBuffer());

const generators = mapWorkbook(workbook);
assert.ok(generators.length >= MIN_GENERATORS,
  `only ${generators.length} generators parsed (< ${MIN_GENERATORS}) — workbook looks truncated, refusing to upsert`);

writeFileSync(OUT_PATH, buildUpsertSql(generators));
console.log(`Wrote ${generators.length} generator upserts to refresh-upsert.sql — apply with npm run refresh:local|refresh:remote`);
