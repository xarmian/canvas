import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// .env lives at the monorepo root (two levels up from apps/web/) so a
// single workspace-wide secrets file feeds both `vite dev` and the
// SvelteKit `$env/*` virtual modules. Resolve to an absolute path so
// Vite's envDir lookup never depends on cwd.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
	// SvelteKit's `analyse` postbuild step forks a Node subprocess that
	// imports the built server bundle — modules guarded on
	// `env.DATABASE_URL` throw at module-load. Vite normally injects
	// envDir vars into `process.env` for the dev server, but the
	// fork inherits the parent's `process.env` which still has only
	// what the shell exported. Explicitly hoist envDir's vars into
	// `process.env` so the analyse subprocess sees them.
	const env = loadEnv(mode, REPO_ROOT, '');
	for (const [k, v] of Object.entries(env)) {
		if (process.env[k] === undefined) process.env[k] = v;
	}

	return {
		envDir: REPO_ROOT,
		plugins: [tailwindcss(), sveltekit()]
	};
});
