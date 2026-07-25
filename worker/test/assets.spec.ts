import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// LAB-419: the dashboard is served from this Worker via wrangler.toml
// [assets]. vitest-pool-workers (0.18) does not route SELF through the
// asset layer, so asset serving itself is verified against wrangler dev /
// the deployed environment; what these lock is that the fetch handler's
// routing still works unchanged under an assets-enabled config.
describe('worker routing with assets configured (LAB-419)', () => {
  it('routes /api/v2/* to the API', async () => {
    const res = await SELF.fetch('https://nem-api.test/api/v2/generators?duid=BAPS');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('404s unknown paths via the worker fallthrough', async () => {
    const res = await SELF.fetch('https://nem-api.test/no-such-page');
    expect(res.status).toBe(404);
  });
});
