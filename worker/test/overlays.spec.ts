import { describe, expect, it } from 'vitest';
import { alignOverlays, OVERLAY_INKS } from '../public/overlays';

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
