#!/usr/bin/env node
// Regenerates migrations/0002_seed_generators.sql from the repo registration CSV.
// Mirrors the legacy api/scrape/nem_registration.js logic: one generator per
// (station name, DUID) pair, first row wins for metadata, reg/max capacities
// summed across physical-unit rows, '-' capacities ignored. Two deliberate
// departures from legacy: the reg_cap/max_cap swap bug on first insert is fixed,
// and the 'unknown' sentinel generator row is not emitted.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const CSV_PATH = new URL('../../api/db/files/nem_registration_latest.csv', import.meta.url);
const OUT_PATH = new URL('../migrations/0002_seed_generators.sql', import.meta.url);

// Every column the seed consumes, resolved from the header by name so a
// reordered/renamed AEMO export fails loudly instead of shifting fields silently.
const COLUMNS = {
  participant: 'Participant',
  name: 'Station Name',
  state: 'Region',
  fuel_type: 'Fuel Source - Primary',
  fuel_description: 'Fuel Source - Descriptor',
  technology_type: 'Technology Type - Primary',
  technology_description: 'Technology Type - Descriptor',
  duid: 'DUID',
  reg_cap: 'Reg Cap (MW)',
  max_cap: 'Max Cap (MW)',
};

// RFC 4180-ish: quoted fields, "" escapes a quote, \r\n or \n row endings.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else { field += c; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function resolveColumns(header) {
  const seen = new Map(); // trimmed header name -> index, or -1 if duplicated
  header.forEach((raw, i) => {
    const name = raw.trim();
    seen.set(name, seen.has(name) ? -1 : i);
  });
  const col = {};
  for (const [key, name] of Object.entries(COLUMNS)) {
    const i = seen.get(name);
    assert.notEqual(i, undefined, `CSV header missing required column: "${name}"`);
    assert.notEqual(i, -1, `CSV header has duplicate required column: "${name}"`);
    col[key] = i;
  }
  return col;
}

function collapseGenerators(rows, col) {
  const byKey = new Map(); // "name\0duid" -> generator
  for (const r of rows) {
    const name = r[col.name].trim(), duid = r[col.duid].trim();
    const reg = Number(r[col.reg_cap].trim()), max = Number(r[col.max_cap].trim()); // '-' -> NaN
    const key = `${name}\0${duid}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        name,
        participant_name: r[col.participant].trim(),
        duid,
        state: r[col.state].trim(),
        technology_type: r[col.technology_type].trim(),
        technology_description: r[col.technology_description].trim(),
        fuel_type: r[col.fuel_type].trim(),
        fuel_description: r[col.fuel_description].trim(),
        reg_cap: Number.isNaN(reg) ? 0 : reg,
        max_cap: Number.isNaN(max) ? 0 : max,
      });
    } else {
      if (!Number.isNaN(reg)) existing.reg_cap += reg;
      if (!Number.isNaN(max)) existing.max_cap += max;
    }
  }
  return [...byKey.values()];
}

const sq = (s) => `'${s.replaceAll("'", "''")}'`;
// Round float-sum artifacts (e.g. 0.1+0.2) to 6dp; capacities are MW with ≤2dp in source.
const num = (n) => String(Math.round(n * 1e6) / 1e6);

function selfCheck() {
  assert.deepEqual(
    parseCsv('a,"b, ""x""",c\r\nd,e,f\n'),
    [['a', 'b, "x"', 'c'], ['d', 'e', 'f']],
    'CSV parser broke on quotes/CRLF',
  );

  const legacyHeader = ['Participant', 'Station Name', 'Region', 'Dispatch Type', 'Category',
    'Classification', 'Fuel Source - Primary', 'Fuel Source - Descriptor', 'Technology Type - Primary',
    'Technology Type - Descriptor', 'Physical Unit No.', 'Unit Size (MW)', 'Aggregation', 'DUID',
    'Reg Cap (MW)', 'Max Cap (MW)', 'Max ROC/Min'];
  const col = resolveColumns(legacyHeader);
  assert.deepEqual(
    [col.participant, col.name, col.state, col.duid, col.reg_cap, col.max_cap],
    [0, 1, 2, 13, 14, 15],
    'column resolution broke on the known AEMO layout',
  );
  assert.throws(() => resolveColumns(legacyHeader.filter((h) => h !== 'DUID')),
    /missing required column: "DUID"/, 'missing column must be fatal');
  assert.throws(() => resolveColumns([...legacyHeader, 'DUID']),
    /duplicate required column: "DUID"/, 'duplicate column must be fatal');

  const rows = [
    ['P1', 'Station A', 'VIC1', '', '', '', 'Hydro', 'Water', 'Renewable', 'Gravity', '', '', '', 'DUID1', '10.5', '20', ''],
    ['P2', 'Station A', 'NSW1', '', '', '', 'Coal', 'Black', 'Fossil', 'Steam', '', '', '', 'DUID1', '-', '5', ''],
  ];
  const [g] = collapseGenerators(rows, col);
  assert.equal(collapseGenerators(rows, col).length, 1, 'dedup by (name,duid) broke');
  assert.equal(g.reg_cap, 10.5, "'-' capacity must not corrupt the sum");
  assert.equal(g.max_cap, 25, 'capacity summing broke');
  assert.equal(g.participant_name, 'P1', 'first row must win for metadata');
  assert.equal(sq("O'Brien"), "'O''Brien'", 'SQL escaping broke');
}

selfCheck();

const csvRows = parseCsv(readFileSync(CSV_PATH, 'utf-8'));
const col = resolveColumns(csvRows.shift());
const generators = collapseGenerators(csvRows, col);
assert.ok(generators.length > 0, 'no generators parsed');

const values = generators.map((g) =>
  `(${[g.name, g.participant_name, g.duid, g.state, g.technology_type, g.technology_description, g.fuel_type, g.fuel_description]
    .map(sq).join(',')},${num(g.reg_cap)},${num(g.max_cap)})`,
);

const batches = [];
for (let i = 0; i < values.length; i += 50) {
  batches.push(
    'INSERT INTO generators (name,participant_name,duid,state,technology_type,technology_description,fuel_type,fuel_description,reg_cap,max_cap) VALUES\n'
    + values.slice(i, i + 50).join(',\n') + ';',
  );
}

writeFileSync(OUT_PATH, `-- GENERATED by scripts/generate-seed.mjs — do not edit by hand.
-- Source: api/db/files/nem_registration_latest.csv (${csvRows.length} unit rows -> ${generators.length} generators).
DELETE FROM generators;
${batches.join('\n')}
`);

console.log(`Wrote ${generators.length} generators (from ${csvRows.length} CSV unit rows) to migrations/0002_seed_generators.sql`);
