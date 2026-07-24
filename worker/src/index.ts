import { BACKFILL_CRON, runBackfill } from './backfill';
import { runIngest } from './ingest';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

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
  // exact cron string: the offset schedule runs the ARCHIVE backfill, anything
  // else the 5-minute CURRENT ingest — so a drifted backfill expression
  // degrades to extra idempotent ingest runs, never a silent no-op handler.
  // Per-file/day errors are isolated inside each runner; a throw here (e.g.
  // the listing fetch itself failing) marks the cron invocation failed in the
  // dashboard, which is exactly the visibility we want — the next run catches
  // up regardless.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === BACKFILL_CRON) {
      await runBackfill(env);
      return;
    }
    await runIngest(env);
  },
} satisfies ExportedHandler<Env>;
