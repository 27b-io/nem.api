import { BACKFILL_CRON, runBackfill } from './backfill';
import { handleApiCached } from './cache';
import { DISPATCH_IS_FEED, runIngest, SCADA_FEED } from './ingest';

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

  // Two cron schedules share this handler (wrangler.toml), dispatched on the
  // exact cron string: the offset schedule runs the ARCHIVE backfills, anything
  // else the 5-minute CURRENT ingests — so a drifted backfill expression
  // degrades to extra idempotent ingest runs, never a silent no-op handler.
  // Both feeds (SCADA, DispatchIS — LAB-1700) run sequentially per invocation
  // with per-feed isolation: one feed's run-level failure (e.g. its listing
  // fetch) must not starve the other, but is still rethrown afterwards so the
  // invocation shows failed in the dashboard — the next run catches up
  // regardless. Per-file/day errors are isolated inside each runner.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const backfill = controller.cron === BACKFILL_CRON;
    const runs: Array<[label: string, run: () => Promise<unknown>]> = backfill
      ? [
          ['backfill:scada', () => runBackfill(env, SCADA_FEED)],
          ['backfill:dispatchis', () => runBackfill(env, DISPATCH_IS_FEED)],
        ]
      : [
          ['ingest:scada', () => runIngest(env, SCADA_FEED)],
          ['ingest:dispatchis', () => runIngest(env, DISPATCH_IS_FEED)],
        ];
    let firstError: unknown;
    for (const [label, run] of runs) {
      try {
        await run();
      } catch (err) {
        console.error(`${label}: run failed:`, err);
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  },
} satisfies ExportedHandler<Env>;
