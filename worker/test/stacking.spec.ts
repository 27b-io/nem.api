import { describe, expect, it } from 'vitest';
import { buildStack, orderSeries } from '../public/stacking';

// The dashboard's diverging-stack transform (LAB-419). The API contract pins
// values as NET MW — batteries go negative while charging and can flip sign
// mid-window — so the stack must cumulate positives up and negatives down
// per interval, not per series.

const ts = [100, 200, 300];

describe('orderSeries', () => {
  it('orders known fuels base→top, battery above, unknowns fold to gray on top', () => {
    const ordered = orderSeries([
      { key: '', values: [1, 1, 1] },
      { key: 'Solar', values: [2, 2, 2] },
      { key: 'Battery storage', values: [3, 3, 3] },
      { key: 'Fossil', values: [4, 4, 4] },
    ]);
    expect(ordered.map((f: { label: string }) => f.label)).toEqual(['Fossil', 'Solar', 'Battery storage', 'Unspecified']);
    // battery lands in the reserved violet slot, unknown in the gray fold
    expect(ordered[2].light).toBe('#4a3aa7');
    expect(ordered[3].light).toBe('#8b8b85');
  });

  it('keeps unknown keys as their own series — never dropped or merged', () => {
    const ordered = orderSeries([
      { key: 'Mystery Fuel', values: [1] },
      { key: 'Another One', values: [2] },
    ]);
    expect(ordered).toHaveLength(2);
    expect(ordered[0].label).toBe('Mystery Fuel');
    // second unknown gets a different gray step
    expect(ordered[0].light).not.toBe(ordered[1].light);
  });
});

describe('buildStack', () => {
  it('cumulates positive fuels in stack order', () => {
    const ordered = orderSeries([
      { key: 'Hydro', values: [10, 20, 30] },
      { key: 'Fossil', values: [100, 100, 100] },
    ]);
    const { data, bands } = buildStack(ordered, 'light', '#fff', ts);
    expect(data[0]).toBe(ts);
    expect(data[1]).toEqual([100, 100, 100]); // Fossil base
    expect(data[2]).toEqual([110, 120, 130]); // Hydro on top
    expect(bands).toEqual([{ series: [2, 1], dir: -1 }]);
  });

  it('stacks a sign-flipping battery per interval: up when discharging, down when charging', () => {
    const ordered = orderSeries([
      { key: 'Battery storage', values: [-50, 0, 80] }, // charging → idle → discharging
      { key: 'Fossil', values: [100, 100, 100] },
      { key: 'Hydro', values: [-5, 10, 10] }, // pumping at t0
    ]);
    const { data, seriesOpts, bands } = buildStack(ordered, 'light', '#fff', ts);
    // Series interleave per fuel (pos half, then neg half); each sign group
    // keeps its own accumulator and band chain, so indices cross-reference.
    expect(data[1]).toEqual([100, 100, 100]); // Fossil pos
    expect(data[2]).toEqual([100, 110, 110]); // Hydro pos — its -5 does not dent the positive stack
    expect(data[3]).toEqual([-5, 0, 0]); // Hydro neg — pumping stacks down from zero
    expect(data[4]).toEqual([100, 110, 190]); // Battery pos half only
    expect(data[5]).toEqual([-55, 0, 0]); // Battery neg cumulates below Hydro's
    // both halves of one fuel wear the same colour
    const hydro = orderSeries([{ key: 'Hydro', values: [1] }])[0];
    expect((seriesOpts[2] as { fill?: string }).fill).toBe(hydro.light);
    expect((seriesOpts[3] as { fill?: string }).fill).toBe(hydro.light);
    // bands: positive chain fills downward, negative chain fills upward,
    // each band paired within its own sign group across the interleaving
    expect(bands).toEqual([
      { series: [2, 1], dir: -1 },
      { series: [4, 2], dir: -1 },
      { series: [5, 3], dir: 1 },
    ]);
  });

  it('treats null (no sample) as zero geometry without breaking accumulation', () => {
    const ordered = orderSeries([
      { key: 'Fossil', values: [100, null, 100] },
      { key: 'Wind', values: [10, 10, null] },
    ]);
    const { data } = buildStack(ordered, 'light', '#fff', ts);
    expect(data[1]).toEqual([100, 0, 100]);
    expect(data[2]).toEqual([110, 10, 100]);
  });

  it('emits no series for an all-null or all-zero fuel', () => {
    const ordered = orderSeries([{ key: 'Solar', values: [null, 0, null] }]);
    const { data, bands } = buildStack(ordered, 'light', '#fff', ts);
    expect(data).toHaveLength(1); // just the x axis
    expect(bands).toEqual([]);
  });
});
