import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for Canvas E2E tests.
 *
 * Tests run against an isolated Postgres database (`canvas_test`) and a
 * dedicated dev server on port 4173 — separate from the developer's running
 * `pnpm dev` (port 5173) so test runs don't pollute the dev DB.
 *
 * The full orchestration lives in the `test:e2e` package script, which:
 *   1. Resets the canvas_test database via scripts/setup-test-db.sh
 *   2. Runs Playwright, which spawns the test server via webServer.command
 */

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ?? 'postgresql://canvas:canvas@localhost:5432/canvas_test';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.test.ts',
	// Fail the build on focused tests left in committed code.
	forbidOnly: !!process.env.CI,
	// Surface flaky tests in CI; locally a single retry is enough to attach a trace.
	retries: process.env.CI ? 2 : 1,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list'], ['html']],
	webServer: {
		// Vite dev server bound to the test port + isolated database.
		command: `vite dev --port ${PORT} --strictPort`,
		port: PORT,
		// Reuse a server the developer already started on the test port (e.g. via
		// `pnpm test:e2e:server`). In CI, no such server exists so Playwright will
		// spawn one. Either way, the `webServer.env` below ensures the spawned
		// instance points at the isolated test database.
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			DATABASE_URL: TEST_DATABASE_URL,
			// Disable HMR overlays etc. that interfere with deterministic tests.
			NODE_ENV: 'test'
		}
	},
	use: {
		baseURL: BASE_URL,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium' }
		}
	]
});

// Re-exported so test files can build absolute URLs (e.g. when constructing
// isolated request contexts via `playwright.request.newContext`).
export { BASE_URL };
