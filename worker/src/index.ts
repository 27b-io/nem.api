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
        return Response.json(
          { status: 'error', message: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
