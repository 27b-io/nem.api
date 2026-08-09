import { describe, expect, it } from 'vitest';
import { REGION_COORDS, WEATHER_INK, WEATHER_VARS, alignWeather, weatherEndpoint } from '../public/weather';

// The weather overlay (LAB-1699): range→endpoint selection and hourly→bucket
// alignment are the only non-trivial logic, so both get pinned here the same
// way overlays.js/ranges.js are.

describe('weatherEndpoint', () => {
  const nowMs = Date.UTC(2026, 7, 9, 3, 0, 0); // 2026-08-09T03:00:00Z

  it('picks the Forecast API for ranges within past_days=92, region coords included', () => {
    const { source, url } = weatherEndpoint('24h', 'NSW1', nowMs);
    expect(source).toBe('forecast');
    const params = new URL(url).searchParams;
    expect(url.startsWith('https://api.open-meteo.com/v1/forecast?')).toBe(true);
    expect(params.get('latitude')).toBe('-33.8688');
    expect(params.get('longitude')).toBe('151.2093');
    expect(params.get('hourly')).toBe('wind_speed_100m,temperature_2m,shortwave_radiation');
    expect(params.get('timezone')).toBe('Australia/Brisbane');
    expect(params.get('past_days')).toBe('1');
    // forecast_days=1, not 0: Open-Meteo's `past_days` window otherwise ends
    // at the START of today (verified live), which would drop "now" entirely.
    expect(params.get('forecast_days')).toBe('1');
  });

  it('scales past_days with the requested range, still under the Forecast API cap', () => {
    expect(new URL(weatherEndpoint('30d', 'NSW1', nowMs).url).searchParams.get('past_days')).toBe('30');
    expect(weatherEndpoint('30d', 'NSW1', nowMs).source).toBe('forecast');
  });

  it('switches to the Historical (archive) API once the window exceeds 92 days', () => {
    const { source, url } = weatherEndpoint('1y', 'NSW1', nowMs);
    expect(source).toBe('historical');
    const params = new URL(url).searchParams;
    expect(url.startsWith('https://archive-api.open-meteo.com/v1/archive?')).toBe(true);
    expect(params.has('past_days')).toBe(false);
    expect(params.get('start_date')).toBe('2025-08-08');
    expect(params.get('end_date')).toBe('2026-08-09');
  });

  it('NEM-wide region ("") and an unknown region both fall back to the NSW1 reference point', () => {
    const nemWide = new URL(weatherEndpoint('24h', '', nowMs).url).searchParams;
    const unknown = new URL(weatherEndpoint('24h', 'QQQ1', nowMs).url).searchParams;
    for (const params of [nemWide, unknown]) {
      expect(params.get('latitude')).toBe(String(REGION_COORDS.NSW1.lat));
      expect(params.get('longitude')).toBe(String(REGION_COORDS.NSW1.lon));
    }
  });

  it('falls back to the 24h window for an unknown range key', () => {
    expect(new URL(weatherEndpoint('bogus', 'NSW1', nowMs).url).searchParams.get('past_days')).toBe('1');
  });

  // Request-forgery invariant (Kody, PR #25): whatever region/range are fed
  // in — URL-ish strings, path traversal, inherited object keys — the fetch
  // target is always an allowlisted Open-Meteo host and the coordinates
  // always come from the fixed REGION_COORDS table. app.js allowlists both
  // upstream; this pins the last line of defence inside weatherEndpoint.
  it('never lets a hostile region/range steer the host or the coordinates', () => {
    const hostile = ['https://evil.example', '//evil.example/x', '../../etc/passwd', '__proto__', 'constructor'];
    for (const region of hostile) {
      for (const range of hostile) {
        const url = new URL(weatherEndpoint(range, region, nowMs).url);
        expect(['api.open-meteo.com', 'archive-api.open-meteo.com']).toContain(url.hostname);
        expect(url.searchParams.get('latitude')).toBe(String(REGION_COORDS.NSW1.lat));
        expect(url.searchParams.get('longitude')).toBe(String(REGION_COORDS.NSW1.lon));
      }
    }
  });

  it('has a reference point for every NEM region plus the NEM-wide default', () => {
    for (const region of ['NSW1', 'QLD1', 'VIC1', 'SA1', 'TAS1', '']) {
      const coords = REGION_COORDS[region];
      expect(coords).toBeDefined();
      expect(Number.isFinite(coords.lat)).toBe(true);
      expect(Number.isFinite(coords.lon)).toBe(true);
    }
  });
});

// Open-Meteo's hourly.time entries are period-STARTING local time; the chart
// axis is period-ENDING (worker/public/ranges.js). Real NEM-aligned unix
// seconds are used throughout so the off-by-one-hour drift the ticket warns
// about would actually show up if the join direction were wrong.
describe('alignWeather', () => {
  const H12 = Date.UTC(2026, 7, 8, 2, 0, 0) / 1000; // 2026-08-08T12:00 AEST (hour start)
  const H13 = H12 + 3600; // 2026-08-08T13:00 AEST
  const weather = {
    hourly: {
      time: ['2026-08-08T12:00', '2026-08-08T13:00'],
      wind_speed_100m: [10, 20],
    },
  };

  it('a chart bucket ending exactly on the hour belongs to the PRECEDING hour, not the one starting there', () => {
    const chartTs = [H13]; // bucket ending 13:00 AEST covers 12:00-13:00, not 13:00-14:00
    expect(alignWeather(chartTs, 300, weather, 'wind_speed_100m')).toEqual([10]);
  });

  it('sub-hour buckets inside an hour all read that hour’s single reading (piecewise-constant)', () => {
    const chartTs = [H12 + 300, H13 + 300]; // 12:05 and 13:05 AEST
    expect(alignWeather(chartTs, 300, weather, 'wind_speed_100m')).toEqual([10, 20]);
  });

  it('hourly-resolution buckets are an exact join; a bucket with no covering hour stays null', () => {
    // Bucket ends: H12 covers 11:00-12:00 (not in the payload); H13 covers
    // 12:00-13:00 (10); H13+3600 covers 13:00-14:00 (20).
    expect(alignWeather([H12, H13, H13 + 3600], 3600, weather, 'wind_speed_100m')).toEqual([null, 10, 20]);
  });

  it('daily buckets average every hourly reading they cover, nulls excluded from the mean', () => {
    // A full AEST day, 2026-08-08 00:00 -> 2026-08-09 00:00: first half at 10,
    // second half at 20, one null in each half — the null must not pull the
    // mean toward zero.
    const dayStart = Date.UTC(2026, 7, 7, 14, 0, 0) / 1000; // 2026-08-08T00:00 AEST
    const dayEnd = dayStart + 86400; // 2026-08-09T00:00 AEST
    const time = Array.from({ length: 24 }, (_, h) => `2026-08-08T${String(h).padStart(2, '0')}:00`);
    const values = Array.from({ length: 24 }, (_, h) => (h === 5 || h === 18 ? null : h < 12 ? 10 : 20));
    const daily = { hourly: { time, wind_speed_100m: values } };
    const [mean] = alignWeather([dayEnd], 86400, daily, 'wind_speed_100m');
    // (11 * 10 + 11 * 20) / 22 = 15 — the two nulls are excluded, not counted as 0.
    expect(mean).toBe(15);
  });

  it('a bucket entirely outside the fetched window stays null, never zero', () => {
    expect(alignWeather([H12 - 7200], 300, weather, 'wind_speed_100m')).toEqual([null]);
  });

  it('handles a missing, malformed, or empty payload without throwing', () => {
    expect(alignWeather([H12], 300, null, 'wind_speed_100m')).toEqual([null]);
    expect(alignWeather([H12], 300, {}, 'wind_speed_100m')).toEqual([null]);
    expect(alignWeather([H12], 300, { hourly: { time: [] } }, 'wind_speed_100m')).toEqual([null]);
    expect(alignWeather([H12], 300, weather, 'temperature_2m')).toEqual([null]); // variable not in this payload
  });
});

describe('WEATHER_VARS and WEATHER_INK', () => {
  it('offers at least wind speed (100 m), temperature and solar irradiance', () => {
    const keys = WEATHER_VARS.map((v) => v.key);
    expect(keys).toContain('wind_speed_100m');
    expect(keys).toContain('temperature_2m');
    expect(keys).toContain('shortwave_radiation');
  });

  it('is a real hex in both themes, and is not a fuel, price, demand, or intensity color', async () => {
    const { FUEL_SLOTS } = await import('../public/stacking');
    const { OVERLAY_INKS } = await import('../public/overlays');
    const taken = new Set([
      ...FUEL_SLOTS.flatMap((f) => [f.light, f.dark]),
      ...Object.values(OVERLAY_INKS).flatMap((i) => [i.light, i.dark]),
    ]);
    for (const theme of ['light', 'dark'] as const) {
      const hex = WEATHER_INK[theme];
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(taken.has(hex)).toBe(false);
    }
  });
});
