import { BACKFILL_CRON, runBackfill } from './backfill';
import { handleApiCached } from './cache';
import { EMISSIONS_CRON, runEmissionsRefresh } from './emissions';
import { runIngest } from './ingest';

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

  // Three cron schedules share this handler (wrangler.toml), dispatched on
  // the exact cron string: the offset schedule runs the ARCHIVE backfill, the
  // daily one the CDEII emissions refresh, anything else the 5-minute CURRENT
  // ingest — so a drifted expression degrades to extra idempotent ingest
  // runs, never a silent no-op handler. Per-file/day errors are isolated
  // inside each runner; a throw here (e.g. the listing fetch itself failing)
  // marks the cron invocation failed in the dashboard, which is exactly the
  // visibility we want — the next run catches up regardless.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === BACKFILL_CRON) {
      await runBackfill(env);
      return;
    }
    if (controller.cron === EMISSIONS_CRON) {
      await runEmissionsRefresh(env);
      return;
    }
    await runIngest(env);
  },
} satisfies ExportedHandler<Env>;
