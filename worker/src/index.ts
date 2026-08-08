import { BACKFILL_CRON, runBackfill } from './backfill';
import { handleApiCached } from './cache';
import { CDEII_CRON, refreshCdeii } from './cdeii';
import { DISPATCH_IS_FEED, type Feed, runIngest, SCADA_FEED } from './ingest';

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
  // exact cron string: one runs the ARCHIVE backfills, one the daily CDEII
  // emissions refresh, anything else the 5-minute CURRENT ingests — so a
  // drifted expression degrades to extra idempotent ingest runs, never a
  // silent no-op handler.
  // Both feeds (SCADA, DispatchIS — LAB-1700) run sequentially per invocation
  // with per-feed isolation: one feed's run-level failure (e.g. its listing
  // fetch) must not starve the other, but is still rethrown afterwards so the
  // invocation shows failed in the dashboard — the next run catches up
  // regardless. Per-file/day errors are isolated inside each runner.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === CDEII_CRON) {
      try {
        await refreshCdeii(env);
      } catch (err) {
        // Same contract as the feed loop below: log with a greppable label,
        // then rethrow so the invocation shows failed in the dashboard.
        console.error('cdeii: refresh failed:', err);
        throw err;
      }
      return;
    }
    const backfill = controller.cron === BACKFILL_CRON;
    // Generic helper (not a .map over the two feeds) so each Feed<Batch>
    // instantiates concretely; the label derives from feed.label so the
    // tail-log namespace can never split from the runners' own tags.
    function entry<B>(feed: Feed<B>): [label: string, run: () => Promise<unknown>] {
      return backfill
        ? [`backfill:${feed.label}`, () => runBackfill(env, feed)]
        : [`ingest:${feed.label}`, () => runIngest(env, feed)];
    }
    let firstError: unknown;
    for (const [label, run] of [entry(SCADA_FEED), entry(DISPATCH_IS_FEED)]) {
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
