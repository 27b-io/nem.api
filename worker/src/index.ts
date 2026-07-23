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
} satisfies ExportedHandler<Env>;
