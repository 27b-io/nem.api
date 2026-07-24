import { handleApi } from './api';
import { runIngest } from './ingest';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Query API (LAB-418): /api/v2/values, /api/v2/values/aggregate, /api/v2/generators.
    if (pathname === '/api/v2' || pathname.startsWith('/api/v2/')) {
      return handleApi(request, env);
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

  // Cron ("*/5 * * * *" in wrangler.toml): ingest new CURRENT Dispatch SCADA
  // files. Per-file errors are isolated inside runIngest; a throw here (e.g.
  // the listing fetch itself failing) marks the cron invocation failed in the
  // dashboard, which is exactly the visibility we want — the next run catches
  // up regardless.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runIngest(env);
  },
} satisfies ExportedHandler<Env>;
