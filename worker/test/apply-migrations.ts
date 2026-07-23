import { applyD1Migrations, env } from 'cloudflare:test';

// Runs once per test file; isolated storage then snapshots per test.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
