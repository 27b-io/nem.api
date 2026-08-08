import { describe, expect, it } from 'vitest';
import { bucketLabel, DEFAULT_RANGE, RANGES, rangeQuery } from '../public/ranges';

// The dashboard time-range selector (LAB-1697). The mapping is the ticket's
// contract: relative-window params only, never an explicit `resolution` —
// the API auto-steps bucket width by window span (worker/API.md).

describe('rangeQuery', () => {
  // Exact-equality pins the full query strings, which also pins the "no
  // explicit resolution param" contract — auto-stepping is the API's job.
  it('maps every range to its pinned API window param', () => {
    expect(Object.fromEntries(RANGES.map((r) => [r.key, rangeQuery(r.key)]))).toEqual({
      '24h': 'hours=24',
      '3d': 'days=3',
      '7d': 'days=7',
      '30d': 'days=30',
      '1y': 'months=12',
      all: 'months=13',
    });
  });

  it('falls back to the default 24 h window for unknown keys', () => {
    expect(rangeQuery('bogus')).toBe('hours=24');
    expect(rangeQuery(DEFAULT_RANGE)).toBe('hours=24');
    expect(DEFAULT_RANGE).toBe('24h');
  });
});

describe('bucketLabel', () => {
  it('names each contract resolution so a daily bucket never claims 5 minutes', () => {
    expect(bucketLabel(300)).toBe('5-min interval');
    expect(bucketLabel(1800)).toBe('30-min interval');
    expect(bucketLabel(3600)).toBe('Hour');
    expect(bucketLabel(86400)).toBe('Day');
  });

  it('degrades to a generic label when resolution is absent from the payload', () => {
    expect(bucketLabel(undefined)).toBe('Interval');
  });
});
