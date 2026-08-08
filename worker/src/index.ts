import { BACKFILL_CRON, runBackfill } from './backfill';
import { handleApiCached } from './cache';
import { CDEII_CRON, refreshCdeii } from './cdeii';
import { runIngest } from './ingest';

// NOTE: this module must export NOTHING but the default handler. workerd reads
// every named export of the entrypoint as an entry in the Worker's handler map
// and refuses to start on anything that isn't a function or ExportedHandler
// ("Incorrect type for map entry ..."), so schedule constants live beside their
// runner (BACKFILL_CRON in ./backfill, CDEII_CRON in ./cdeii) rather than here.
// test/index.spec.ts guards this — the vitest pool imports the handler object
// directly and never exercises workerd's validation.

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Query API (LAB-418): /api/v2/values, /api/v2/values/aggregate,
    // /api/v2/generators — cache-fronted (LAB-768, see src/cache.ts).
    if (pathname === '/api/v2' || pathname.startsWith('/api/v2/')) {
      return handleApiCached(request, env);
    }

    if (pathname === '/health') {
      try {
        const row = await env.DB.prepare('SELECT count(*) AS n FROM generators').first<{ n: number }>();
        return Response.json({ status: 'ok', generators: row?.n ?? 0 });
      } catch (err) {
        // Raw D1 errors stay in the logs (wrangler tail / dashboard), not the public response.
        console.error('health check failed:', err);
        return Response.json({ status: 'error' }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },

  // Three cron schedules share this handler (wrangler.toml), dispatched on the
  // exact cron string: one runs the ARCHIVE backfill, one the daily CDEII
  // emissions refresh, anything else the 5-minute CURRENT ingest — so a
  // drifted expression degrades to extra idempotent ingest runs, never a
  // silent no-op handler.
  // Per-file/day errors are isolated inside each runner; a throw here (e.g.
  // the listing fetch itself failing) marks the cron invocation failed in the
  // dashboard, which is exactly the visibility we want — the next run catches
  // up regardless.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === BACKFILL_CRON) {
      await runBackfill(env);
      return;
    }
    if (controller.cron === CDEII_CRON) {
      await refreshCdeii(env);
      return;
    }
    await runIngest(env);
  },
} satisfies ExportedHandler<Env>;
