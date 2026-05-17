import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

// .env lives at the monorepo root. `pnpm --filter web db:*` runs this
// config with cwd=apps/web, so the default `dotenv/config` would look
// for `apps/web/.env` and miss the workspace-wide secrets file.
// (Codex round 1 P2.)
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

if (!process.env.DATABASE_URL) {
	throw new Error('DATABASE_URL environment variable is not set');
}

export default defineConfig({
	out: './drizzle/migrations',
	schema: ['./src/lib/server/db/schema.ts', './src/lib/server/db/auth-schema.ts'],
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_URL
	}
});
