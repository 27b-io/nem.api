import { describe, expect, it } from 'vitest';
import { bucketLabel, DEFAULT_RANGE, isRange, RANGES, rangeParams } from '../public/ranges';

describe('rangeParams', () => {
  it('maps every range to its worker/API.md relative-window param', () => {
    expect(rangeParams('24h')).toEqual({ hours: 24 });
    expect(rangeParams('3d')).toEqual({ days: 3 });
    expect(rangeParams('7d')).toEqual({ days: 7 });
    expect(rangeParams('30d')).toEqual({ days: 30 });
    expect(rangeParams('1y')).toEqual({ months: 12 });
    expect(rangeParams('all')).toEqual({ months: 13 });
  });

  it('falls back to the default range for an unknown value', () => {
    expect(rangeParams('bogus')).toEqual(rangeParams(DEFAULT_RANGE));
  });

  it('never sends an explicit resolution param', () => {
    for (const [value] of RANGES) {
      expect(rangeParams(value)).not.toHaveProperty('resolution');
    }
  });
});

describe('isRange', () => {
  it('accepts every known range value and rejects anything else', () => {
    for (const [value] of RANGES) expect(isRange(value)).toBe(true);
    expect(isRange('1w')).toBe(false);
    expect(isRange('')).toBe(false);
  });
});

describe('bucketLabel', () => {
  it('matches worker/API.md auto-step thresholds', () => {
    expect(bucketLabel(300)).toBe('5-min interval');
    expect(bucketLabel(1800)).toBe('30-min interval');
    expect(bucketLabel(3600)).toBe('Hourly interval');
    expect(bucketLabel(86400)).toBe('Daily interval');
  });
});
