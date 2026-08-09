import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../public/chrome';

// fetchJson's contract is "throws, with the URL in the message" — both pages
// fan several fetches into one Promise.all, where a bare error names nothing.
// HTTP errors always carried the URL; these pin that transport errors
// (DNS, offline, abort) do too.

describe('fetchJson', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the URL on transport errors, keeping the original as cause', async () => {
    const boom = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', () => Promise.reject(boom));
    const err = await fetchJson('https://api.open-meteo.com/v1/forecast?x=1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('https://api.open-meteo.com/v1/forecast?x=1');
    expect((err as Error).message).toContain('Failed to fetch');
    expect((err as Error).cause).toBe(boom);
  });

  it('still surfaces the API error body with the URL on non-ok responses', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ error: 'no such range' }), { status: 400 })),
    );
    const err = await fetchJson('/api/v2/values?range=bogus').catch((e: unknown) => e);
    expect((err as Error).message).toBe('/api/v2/values?range=bogus: no such range');
  });
});
