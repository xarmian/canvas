import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest configuration for Canvas unit tests.
 *
 * Unit tests live next to the modules they cover under `src/**\/*.test.ts`.
 * The Playwright e2e suite lives in `e2e/**\/*.test.ts` and is run via
 * `pnpm test:e2e`, so the two test runners never see each other's files
 * even though both use the `.test.ts` suffix.
 *
 * `$env/dynamic/private` is a SvelteKit-runtime virtual module that
 * doesn't exist outside `vite dev` / `vite build`. We alias it to a tiny
 * stub so server-side modules (e.g. `$lib/server/db`) can be imported in
 * unit tests without crashing on the env-var guard at module top-level.
 * The pure helpers exercised by the tests never make a DB call.
 */
export default defineConfig({
	resolve: {
		alias: {
			'$env/dynamic/private': fileURLToPath(
				new URL('./src/test/env-private-stub.ts', import.meta.url)
			),
			// SvelteKit's `$lib` alias is normally provided by the vite-plugin-
			// svelte build; vitest doesn't run that pipeline, so re-declare it
			// here so server-side modules that walk into `$lib/engine` /
			// `$lib/server/*` resolve identically in unit tests.
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
