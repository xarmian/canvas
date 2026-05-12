import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Canvas unit tests.
 *
 * Unit tests live next to the modules they cover under `src/**\/*.test.ts`.
 * The Playwright e2e suite lives in `e2e/**\/*.test.ts` and is run via
 * `pnpm test:e2e`, so the two test runners never see each other's files
 * even though both use the `.test.ts` suffix.
 */
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
