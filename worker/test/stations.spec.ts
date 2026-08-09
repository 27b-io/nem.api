import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  dominantFuel,
  emissionsRate,
  facilityOutput,
  joinStations,
  markerRadius,
  mercator,
  sparkPath,
  unitAliases,
} from '../public/stations';

// `stations.js` is plain ESM shared with the browser, so its object literals
// infer as {} / any[] here; these two readers put a shape on them at the point
// of use rather than dragging a type layer into a module the browser loads.
const duidsOf = (facility: unknown): Record<string, string> =>
  (facility as { duids: Record<string, string> }).duids;
const unitsOf = (station: unknown): Array<{ duid: string; match: string }> =>
  (station as { units: Array<{ duid: string; match: string }> }).units;

// The station map's pure core (LAB-1702). Two joins live in that module and
// neither may fail quietly: a DUID that lands on the wrong station puts a coal
// plant in the wrong state, and a DUID that vanishes takes a power station off
// the map without saying so.

describe('unitAliases', () => {
  it('leaves a real AEMO DUID alone', () => {
    expect(unitAliases('BW01')).toEqual(['BW01']);
    expect(unitAliases('TORRB1')).toEqual(['TORRB1']);
  });

  it("recovers the AEMO DUID from Open Electricity's synthesised battery pair", () => {
    // AEMO dispatches BRDDBES1; OE models it as a charge/discharge pair.
    expect(unitAliases('0BRDDBESL1')).toEqual(['0BRDDBESL1', 'BRDDBESL1', 'BRDDBES1']);
    expect(unitAliases('0BRDDBESG1')).toEqual(['0BRDDBESG1', 'BRDDBESG1', 'BRDDBES1']);
    // A 0-prefixed code with no L/G/B split yields only the stripped form —
    // the split rule must not fire on a name that merely ends in a digit.
    expect(unitAliases('0ELAINEBESS1')).toEqual(['0ELAINEBESS1', 'ELAINEBESS1']);
  });
});

const facility = (code: string, units: string[], over: Record<string, unknown> = {}) => ({
  code,
  name: code,
  network_id: 'NEM',
  network_region: 'NSW1',
  location: { lat: -33, lng: 151 },
  units: units.map((c) => ({ code: c })),
  ...over,
});

describe('buildSnapshot', () => {
  it('keeps NEM facilities with coordinates and reports the rest', () => {
    const { facilities, skipped } = buildSnapshot([
      facility('A', ['A1']),
      facility('W', ['W1'], { network_id: 'WEM' }),
      facility('N', ['N1'], { location: null }),
    ]);
    expect(facilities.map((f) => f.code)).toEqual(['A']);
    expect(skipped).toEqual([{ code: 'N', reason: 'no coordinates' }]);
  });

  it('carries the facility wikipedia link and the first owner website', () => {
    const { facilities } = buildSnapshot([
      facility('A', ['A1'], {
        wikipedia: 'https://en.wikipedia.org/wiki/A',
        owners: [{ name: 'No site' }, { name: 'Owner', website: 'https://owner.example' }],
      }),
    ]);
    expect(facilities[0].wikipedia).toBe('https://en.wikipedia.org/wiki/A');
    expect(facilities[0].website).toBe('https://owner.example');
  });

  it('nulls the links when upstream has none, rather than leaving them undefined', () => {
    const { facilities } = buildSnapshot([facility('A', ['A1'])]);
    expect(facilities[0]).toMatchObject({ wikipedia: null, website: null });
  });

  it('lets an exact code beat another facility’s alias regardless of dump order', () => {
    // BESS1 is a real DUID at B, and also what A's synthesised code aliases to.
    const ordered = buildSnapshot([facility('A', ['0BESSL1']), facility('B', ['BESS1'])]);
    const reversed = buildSnapshot([facility('B', ['BESS1']), facility('A', ['0BESSL1'])]);
    for (const { facilities, conflicts } of [ordered, reversed]) {
      const owner = facilities.find((f) => 'BESS1' in f.duids);
      expect(owner?.code).toBe('B');
      expect(duidsOf(owner).BESS1).toBe('exact');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ duid: 'BESS1', kind: 'alias', heldKind: 'exact' });
    }
  });

  it('reports two facilities whose aliases collide instead of silently picking one', () => {
    const { conflicts } = buildSnapshot([facility('A', ['0XL1']), facility('B', ['0XG1'])]);
    expect(conflicts).toEqual([
      expect.objectContaining({ duid: 'X1', kind: 'alias', facility: 'B', heldBy: 'A', heldKind: 'alias' }),
    ]);
  });

  it("does not treat one facility's own charge/discharge pair as a conflict", () => {
    const { facilities, conflicts } = buildSnapshot([facility('A', ['0AL1', '0AG1'])]);
    expect(conflicts).toEqual([]);
    expect(duidsOf(facilities[0]).A1).toBe('alias');
  });
});

const snapshot = {
  facilities: [
    {
      code: 'BAYSW', name: 'Bayswater', region: 'NSW1', lat: -32.39, lng: 150.95,
      wikipedia: null, website: null, duids: { BW01: 'exact', BW02: 'exact' },
    },
    {
      code: 'BRDD', name: 'Broadsound', region: 'QLD1', lat: -22.3, lng: 149.5,
      wikipedia: null, website: null, duids: { BRDDSF01: 'exact', BRDDBES1: 'alias' },
    },
  ],
};

const gen = (duid: string, over: Record<string, unknown> = {}) => ({
  duid, name: duid, participant_name: 'P', state: 'NSW1',
  fuel_type: 'Fossil', reg_cap: 100, emissions_factor: null, ...over,
});

describe('joinStations', () => {
  it('groups units into stations and sums registered capacity', () => {
    const { stations } = joinStations(snapshot, [gen('BW01', { reg_cap: 660 }), gen('BW02', { reg_cap: 660 })]);
    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({ code: 'BAYSW', capacity: 1320, fuel: 'Fossil', region: 'NSW1' });
    expect(unitsOf(stations[0]).map((u) => u.duid)).toEqual(['BW01', 'BW02']);
  });

  it('lists a DUID the snapshot has never heard of instead of dropping it', () => {
    const { stations, unmatched } = joinStations(snapshot, [gen('NOSUCH1', { name: 'Nowhere Wind' })]);
    expect(stations).toEqual([]);
    expect(unmatched).toEqual([{ duid: 'NOSUCH1', name: 'Nowhere Wind', state: 'NSW1', fuel_type: 'Fossil' }]);
  });

  it('refuses to pin a unit the two sources place in different regions', () => {
    const { stations, regionMismatch } = joinStations(snapshot, [gen('BW01', { state: 'VIC1' })]);
    expect(stations).toEqual([]);
    expect(regionMismatch).toEqual([{ duid: 'BW01', ours: 'VIC1', snapshot: 'NSW1', facility: 'BAYSW' }]);
  });

  it('pins a unit whose own registration row has a blank region (ADPPV3)', () => {
    // Blank is a hole in AEMO's workbook, not a second opinion — see stations.js.
    const { stations, regionMismatch } = joinStations(snapshot, [gen('BW01', { state: '' })]);
    expect(regionMismatch).toEqual([]);
    expect(stations[0].code).toBe('BAYSW');
  });

  it('ignores non-market units, which have no DUID to join on', () => {
    const { stations, unmatched } = joinStations(snapshot, [gen('-')]);
    expect(stations).toEqual([]);
    expect(unmatched).toEqual([]);
  });

  it('records how each unit matched, so an alias join stays auditable', () => {
    const { stations } = joinStations(snapshot, [
      gen('BRDDSF01', { state: 'QLD1', fuel_type: 'Solar', reg_cap: 150 }),
      gen('BRDDBES1', { state: 'QLD1', fuel_type: 'Battery Storage', reg_cap: 100 }),
    ]);
    expect(unitsOf(stations[0]).map((u) => [u.duid, u.match])).toEqual([
      ['BRDDBES1', 'alias'],
      ['BRDDSF01', 'exact'],
    ]);
  });
});

describe('dominantFuel', () => {
  it('picks the largest capacity, not the most units', () => {
    expect(dominantFuel([
      { fuel_type: 'Solar', reg_cap: 150 },
      { fuel_type: 'Battery Storage', reg_cap: 40 },
      { fuel_type: 'Battery Storage', reg_cap: 40 },
    ])).toBe('Solar');
  });

  it('is deterministic on a capacity tie, so marker colour never depends on payload order', () => {
    const units = [{ fuel_type: 'Wind', reg_cap: 50 }, { fuel_type: 'Hydro', reg_cap: 50 }];
    expect(dominantFuel(units)).toBe('Hydro');
    expect(dominantFuel([...units].reverse())).toBe('Hydro');
  });

  it('folds a missing fuel to the empty key rather than throwing', () => {
    expect(dominantFuel([{ fuel_type: null, reg_cap: 1 }])).toBe('');
    expect(dominantFuel([])).toBe('');
  });
});

describe('mercator', () => {
  it('puts north up and keeps longitude linear', () => {
    expect(mercator(150, 0).x).toBe(150);
    expect(mercator(150, 0).y).toBeCloseTo(0, 10);
    // SVG y grows downward: further south must be further down the screen.
    expect(mercator(150, -33).y).toBeGreaterThan(mercator(150, -10).y);
  });

  it('stretches latitude away from the equator, which is what makes it Mercator', () => {
    const near = Math.abs(mercator(0, -10).y - mercator(0, 0).y);
    const far = Math.abs(mercator(0, -40).y - mercator(0, -30).y);
    expect(far).toBeGreaterThan(near);
  });
});

describe('markerRadius', () => {
  it('scales by area: 4x the capacity is 2x the radius above the floor', () => {
    const min = 0;
    expect(markerRadius(100, 100, min, 16)).toBeCloseTo(16);
    expect(markerRadius(25, 100, min, 16)).toBeCloseTo(8);
  });

  it('keeps the smallest station clickable', () => {
    expect(markerRadius(0.02, 2880, 3, 16)).toBeGreaterThanOrEqual(3);
  });

  it('survives an empty or degenerate station set', () => {
    expect(markerRadius(10, 0)).toBe(3);
    expect(markerRadius(-5, 100, 3, 16)).toBe(3);
  });
});

const values = {
  timestamps: [100, 200, 300],
  series: [
    { duid: 'BW01', values: [10, 20, 30] },
    { duid: 'BW02', values: [5, null, 15] },
    { duid: 'BW03', values: [null, null, null] },
  ],
};

describe('facilityOutput', () => {
  it('sums the reporting units per bucket', () => {
    const out = facilityOutput(values, ['BW01', 'BW02', 'BW03']);
    expect(out.total).toEqual([15, 20, 45]);
  });

  it('separates "no reading this interval" from "not reporting at all"', () => {
    const out = facilityOutput(values, ['BW01', 'BW02', 'BW03', 'BW04']);
    expect(out.reporting).toEqual(['BW01', 'BW02']);
    expect(out.missing).toEqual(['BW03', 'BW04']);
  });

  it('names the units absent from the latest bucket so a partial total says so', () => {
    const partial = { timestamps: [100, 200], series: [
      { duid: 'BW01', values: [10, 20] },
      { duid: 'BW02', values: [5, null] },
    ] };
    const out = facilityOutput(partial, ['BW01', 'BW02']);
    expect(out.latest).toEqual({ value: 20, time: 200, byDuid: { BW01: 20 }, absent: ['BW02'] });
  });

  it('falls back to the last bucket that has any reading', () => {
    const trailing = { timestamps: [100, 200, 300], series: [{ duid: 'BW01', values: [10, 20, null] }] };
    expect(facilityOutput(trailing, ['BW01']).latest).toMatchObject({ value: 20, time: 200 });
  });

  it('reports an empty window as no data rather than zero', () => {
    const out = facilityOutput({ timestamps: [], series: [] }, ['BW01']);
    expect(out.latest).toBeNull();
    expect(out.total).toEqual([]);
    expect(out.missing).toEqual(['BW01']);
  });

  it('keeps a bucket with no reporting unit null, never 0', () => {
    const gap = { timestamps: [100, 200], series: [{ duid: 'BW01', values: [null, 20] }] };
    expect(facilityOutput(gap, ['BW01']).total).toEqual([null, 20]);
  });

  it('survives a missing payload', () => {
    expect(facilityOutput(null, ['BW01'])).toMatchObject({ total: [], latest: null, missing: ['BW01'] });
  });
});

describe('emissionsRate', () => {
  const units = [
    { duid: 'A', emissions_factor: 0.9 },
    { duid: 'B', emissions_factor: 0.8 },
    { duid: 'C', emissions_factor: null },
  ];

  it('sums MW x factor over the units with a published factor', () => {
    const out = emissionsRate(units, { A: 100, B: 50 });
    expect(out.rate).toBeCloseTo(130);
    expect(out.coveredMw).toBe(150);
  });

  it('excludes an unfactored unit from both halves and discloses it', () => {
    const out = emissionsRate(units, { A: 100, C: 100 });
    expect(out.rate).toBeCloseTo(90);
    expect(out.unfactored).toEqual(['C']);
    expect(out.coveredMw).toBe(100); // C's 100 MW is in neither half
  });

  it('ignores charging and station load — a net consumer sends nothing out', () => {
    const out = emissionsRate(units, { A: 100, B: -40 });
    expect(out.rate).toBeCloseTo(90);
    expect(out.coveredMw).toBe(100);
  });

  it('returns a null rate, not 0, when nothing factored is generating', () => {
    expect(emissionsRate(units, { C: 100 })).toMatchObject({ rate: null, unfactored: ['C'] });
    expect(emissionsRate(units, {})).toMatchObject({ rate: null, coveredMw: 0 });
    expect(emissionsRate(units, undefined)).toMatchObject({ rate: null });
  });
});

describe('sparkPath', () => {
  const evenly = [0, 300, 600, 900];

  it('maps x by time and y by value, with zero always in the domain', () => {
    const spark = sparkPath(evenly, [100, 50, 100, 0], 100, 30);
    // max=100 -> y 0, min=0 -> y 30 (SVG y grows downward).
    expect(spark?.d).toBe('M0.00 0.00L33.33 15.00L66.67 0.00L100.00 30.00');
    expect(spark).toMatchObject({ low: 0, high: 100, zeroY: 30 });
  });

  it('reports the REAL extremes, not the zero-padded plot domain', () => {
    // A coal station that never dropped below 400 MW must not be captioned
    // "0 to 520 MW" just because the domain is padded down to zero.
    const spark = sparkPath(evenly, [400, 480, 520, 455], 100, 30);
    expect(spark).toMatchObject({ low: 400, high: 520 });
    expect(spark?.zeroY).toBe(30); // …while zero is still the baseline
  });

  it('spaces an outage by its real duration, not by bucket count', () => {
    // Same four readings, but a two-hour hole before the last one: the final
    // segment must be long, not another even step.
    const spark = sparkPath([0, 300, 600, 7800], [100, 50, 100, 0], 100, 30);
    expect(spark?.d).toBe('M0.00 0.00L3.85 15.00L7.69 0.00L100.00 30.00');
  });

  it('lifts the pen over a null bucket instead of bridging it', () => {
    const spark = sparkPath(evenly, [100, null, null, 50], 100, 30);
    // Each isolated reading gets a zero-length segment of its own, so a round
    // cap renders it as a dot. A bare `M` would draw nothing at all and the
    // sample would silently vanish.
    expect(spark?.d).toBe('M0.00 0.00L0.00 0.00M100.00 15.00L100.00 15.00');
  });

  it('keeps a single sample after an outage visible', () => {
    const spark = sparkPath([0, 300, 600, 900], [null, 40, null, 80], 100, 30);
    expect(spark?.d).toBe('M33.33 15.00L33.33 15.00M100.00 0.00L100.00 0.00');
  });

  it('puts a charging battery below the zero line', () => {
    const spark = sparkPath([0, 300], [-40, 40], 100, 30);
    expect(spark?.zeroY).toBe(15);
    expect(spark?.low).toBe(-40);
  });

  it('draws nothing from fewer than two readings, or a mismatched pair of arrays', () => {
    expect(sparkPath(evenly, [null, null, null, 5], 100, 30)).toBeNull();
    expect(sparkPath([], [], 100, 30)).toBeNull();
    expect(sparkPath([0, 300], [1, 2, 3], 100, 30)).toBeNull();
  });
});
