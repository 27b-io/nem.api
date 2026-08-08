import { describe, expect, it } from 'vitest';
import { alignOverlays, alignRooftop, OVERLAY_INKS } from '../public/overlays';

// The dashboard's price/demand overlay alignment (LAB-1700). Both endpoints
// bucket with the same server-side expression, so equal windows yield equal
// timestamps — but ingest lag can skew one payload's tail, and NEM-wide view
// has no single spot price. This transform owns both rules.

const chartTs = [100, 200, 300];

const dispatch = {
  timestamps: [100, 200, 300],
  series: [
    { region: 'NSW1', price: [110, -8.5, 17500], price_max: [110, -8.5, 17500], demand: [9000, 9100, null] },
    { region: 'VIC1', price: [90, 91, 92], price_max: [90, 91, 92], demand: [6000, null, 6200] },
  ],
};

describe('alignOverlays', () => {
  it('selects a single region: its price (spikes and negatives intact) and demand', () => {
    const { price, demand } = alignOverlays(chartTs, dispatch, 'NSW1');
    expect(price).toEqual([110, -8.5, 17500]);
    expect(demand).toEqual([9000, 9100, null]);
  });

  it('NEM-wide (region ""): demand sums across regions, price stays all-null (no NEM-wide spot price)', () => {
    const { price, demand } = alignOverlays(chartTs, dispatch, '');
    expect(price).toEqual([null, null, null]);
    // null contributes nothing; an all-null bucket stays null, not 0.
    expect(demand).toEqual([15000, 9100, 6200]);
  });

  it('aligns by timestamp lookup — a bucket missing from the dispatch payload stays null', () => {
    const laggy = {
      timestamps: [100, 300],
      series: [{ region: 'NSW1', price: [110, 112], price_max: [110, 112], demand: [9000, 9050] }],
    };
    const { price, demand } = alignOverlays(chartTs, laggy, 'NSW1');
    expect(price).toEqual([110, null, 112]);
    expect(demand).toEqual([9000, null, 9050]);
  });

  it('handles a missing or empty payload and an unknown region without throwing', () => {
    expect(alignOverlays(chartTs, null, 'NSW1')).toEqual({ price: [null, null, null], demand: [null, null, null] });
    expect(alignOverlays(chartTs, { timestamps: [], series: [] }, 'NSW1')).toEqual({
      price: [null, null, null],
      demand: [null, null, null],
    });
    expect(alignOverlays(chartTs, dispatch, 'QLD1')).toEqual({
      price: [null, null, null],
      demand: [null, null, null],
    });
  });
});

// The rooftop band's projection (LAB-1701): a 30-minute AEMO estimate onto a
// 5-minute chart axis. NEM buckets are period-ending and AEST-aligned; these
// fixtures use real NEM-aligned unix seconds so the covering arithmetic (the
// +10h offset) is exercised, not bypassed.
describe('alignRooftop', () => {
  // 2026-08-08 13:30 and 14:00 AEST, period-ending half-hours.
  const H1 = Date.UTC(2026, 7, 8, 13, 30) / 1000 - 36000;
  const H2 = H1 + 1800;
  const rooftop = {
    timestamps: [H1, H2],
    series: [
      { region: 'NSW1', power: [4000, 4100] },
      { region: 'VIC1', power: [3000, null] }, // no VIC estimate for the second half-hour
    ],
  };

  it('expands each half-hour estimate across the 5-min buckets it covers, null beyond the last estimate', () => {
    // Chart axis: 13:05 → 14:20 at 5 minutes — the last four buckets fall in
    // half-hours AEMO has not published yet (the live edge).
    const chartTs = Array.from({ length: 16 }, (_, i) => H1 - 1500 + i * 300);
    const values = alignRooftop(chartTs, 300, rooftop, 'NSW1');
    expect(values).toEqual([
      ...Array(6).fill(4000), // 13:05–13:30 covered by the 13:30 estimate
      ...Array(6).fill(4100), // 13:35–14:00 covered by the 14:00 estimate
      null, null, null, null, // 14:05–14:20: nothing published — absent, not zero
    ]);
  });

  it('NEM-wide sums the regions that have an estimate; an all-null bucket stays null', () => {
    const values = alignRooftop([H1, H2], 1800, rooftop, '');
    expect(values).toEqual([7000, 4100]);
    const nothing = { timestamps: [H1], series: [{ region: 'NSW1', power: [null] }] };
    expect(alignRooftop([H1], 1800, nothing, '')).toEqual([null]);
  });

  it('at chart resolutions ≥ 30 min the covering lookup is an exact timestamp join', () => {
    expect(alignRooftop([H1, H2], 1800, rooftop, 'VIC1')).toEqual([3000, null]);
    // Hourly axis: the rooftop payload would be served at 3600 too — an
    // hour-ending bucket joins itself, a missing one stays null.
    const hourly = { timestamps: [H2], series: [{ region: 'NSW1', power: [4050] }] };
    expect(alignRooftop([H2, H2 + 3600], 3600, hourly, 'NSW1')).toEqual([4050, null]);
  });

  it('daily buckets end at AEST midnight — the +10h offset in the covering step is load-bearing', () => {
    // Daily bucket ending 2026-08-09 00:00 AEST = 2026-08-08 14:00 UTC:
    // NOT divisible by 86400, so dropping the NEM offset would compute a
    // different covering bucket and this join would come back null.
    const dayEnd = Date.UTC(2026, 7, 8, 14) / 1000;
    expect((dayEnd + 36000) % 86400).toBe(0); // fixture sanity: AEST-midnight-ending
    expect(dayEnd % 86400).not.toBe(0);
    const daily = { timestamps: [dayEnd], series: [{ region: 'NSW1', power: [980] }] };
    expect(alignRooftop([dayEnd], 86400, daily, 'NSW1')).toEqual([980]);
  });

  it('handles a missing or empty payload and an unknown region without throwing', () => {
    expect(alignRooftop([H1], 300, null, 'NSW1')).toEqual([null]);
    expect(alignRooftop([H1], 300, { timestamps: [], series: [] }, 'NSW1')).toEqual([null]);
    expect(alignRooftop([H1], 300, rooftop, 'QLD1')).toEqual([null]);
  });
});

describe('OVERLAY_INKS', () => {
  it('defines both themes for both overlays, and none of the inks is a fuel-palette hue', async () => {
    const { FUEL_SLOTS } = await import('../public/stacking');
    const fuelHexes = new Set(FUEL_SLOTS.flatMap((f: { light: string; dark: string }) => [f.light, f.dark]));
    for (const kind of ['price', 'demand'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const hex = OVERLAY_INKS[kind][theme];
        expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
        expect(fuelHexes.has(hex)).toBe(false);
      }
    }
  });
});
