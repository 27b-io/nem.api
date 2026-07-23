// The vitest-pool-workers `env` is typed via the global Cloudflare.Env
// namespace; declare our bindings (matching src/index.ts Env) plus the
// test-only migrations binding from vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ARCHIVE: R2Bucket;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
