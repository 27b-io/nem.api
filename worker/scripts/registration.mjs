// Registration-list logic shared by generate-seed.mjs (repo CSV seed) and
// refresh-generators.mjs (live AEMO workbook refresh, LAB-421). One home for
// the collapse semantics so seed and refresh can never disagree on what a
// "generator" is: one row per (station name, DUID), first unit row wins for
// metadata, capacities summed across unit rows, '-' capacities ignored.
import assert from 'node:assert/strict';

/**
 * Resolve every column in `columns` ({key: header name}) to its index in
 * `header`, by name — so a reordered/renamed AEMO export fails loudly
 * instead of shifting fields silently.
 */
export function resolveColumns(header, columns) {
  const seen = new Map(); // trimmed header name -> index, or -1 if duplicated
  header.forEach((raw, i) => {
    const name = raw.trim();
    seen.set(name, seen.has(name) ? -1 : i);
  });
  const col = {};
  for (const [key, name] of Object.entries(columns)) {
    const i = seen.get(name);
    assert.notEqual(i, undefined, `header missing required column: "${name}"`);
    assert.notEqual(i, -1, `header has duplicate required column: "${name}"`);
    col[key] = i;
  }
  return col;
}

/** Collapse physical-unit rows (arrays indexed by `col`) into generators. */
export function collapseGenerators(rows, col) {
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

export const sq = (s) => `'${s.replaceAll("'", "''")}'`;
// Round float-sum artifacts (e.g. 0.1+0.2) to 6dp; capacities are MW with ≤2dp in source.
export const num = (n) => String(Math.round(n * 1e6) / 1e6);

export const GENERATOR_COLUMNS =
  'name,participant_name,duid,state,technology_type,technology_description,fuel_type,fuel_description,reg_cap,max_cap';

/** One `(...)` SQL values tuple per generator, in GENERATOR_COLUMNS order. */
export const sqlTuple = (g) =>
  `(${[g.name, g.participant_name, g.duid, g.state, g.technology_type, g.technology_description, g.fuel_type, g.fuel_description]
    .map(sq).join(',')},${num(g.reg_cap)},${num(g.max_cap)})`;
