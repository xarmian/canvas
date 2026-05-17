#!/usr/bin/env node
/**
 * One-shot drizzle migration runner for production startup.
 *
 * Why this exists
 * ===============
 * The repo's dev workflow uses `drizzle-kit migrate` (a devDep CLI).
 * Shipping drizzle-kit + its transitive deps into the production
 * image inflates it by ~50MB and pulls in a TypeScript runtime we
 * otherwise don't need at runtime. drizzle-orm itself (a runtime
 * dep) exposes a programmatic migrator that reads the same
 * `drizzle/` SQL output and applies it via a single Postgres
 * connection — no CLI, no extra deps.
 *
 * Contract
 * ========
 * - Reads `DATABASE_URL` from env. Exits non-zero with a clear
 *   message if missing — the container should refuse to come up
 *   rather than silently start an un-migrated server.
 * - Applies migrations from the baked-in `drizzle/` folder
 *   (copied into the image at /app/drizzle by the Dockerfile).
 * - Closes the migration connection cleanly so postgres-js
 *   doesn't keep an idle socket around when the main server
 *   starts.
 *
 * Called from the production CMD as the first step before
 * `node build/index.js`. Brief downtime during deploy is
 * acceptable for v0.4 (TASK-76 scope) — this script runs on every
 * container start; idempotent because drizzle's migrator tracks
 * applied migrations in its own `__drizzle_migrations` table.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	console.error('[migrate] DATABASE_URL is required');
	process.exit(1);
}

// `max: 1` because the migrator runs serially and we want to release
// the connection promptly. Larger pool sizes are pointless here and
// would leave idle sockets dangling at the moment the app server
// starts and opens its own pool.
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

try {
	// Path mirrors `drizzle.config.ts`'s `out:` setting. Drizzle's
	// migrator expects to find `<folder>/meta/_journal.json` plus the
	// numbered `.sql` files alongside it.
	console.log('[migrate] applying migrations from ./drizzle/migrations');
	await migrate(db, { migrationsFolder: './drizzle/migrations' });
	console.log('[migrate] up to date');
} catch (err) {
	console.error('[migrate] failed:', err);
	process.exit(1);
} finally {
	await client.end({ timeout: 5 });
}
