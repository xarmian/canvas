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
		// Always spawn a fresh server so `webServer.env.DATABASE_URL` is
		// guaranteed to apply. Reusing a process that happens to be listening
		// on the test port could let stale env (e.g. the dev DB) silently bind
		// to the test run, which defeats the purpose of the isolated database.
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			DATABASE_URL: TEST_DATABASE_URL,
			// Better Auth derives callback/redirect URLs from BETTER_AUTH_URL
			// (or the request Host); without it the client-side wrapper warns
			// at startup and some flows can produce inconsistent cookies.
			// Pin it to the test base URL so flows match the dev experience.
			BETTER_AUTH_URL: BASE_URL,
			// Some auth/session helpers also read PUBLIC_APP_URL when building
			// share URLs in server load functions; keep them aligned.
			PUBLIC_APP_URL: BASE_URL,
			// Lower the render-route protection limits so the throttle e2e
			// can reach 429/503 without thousands of requests. Production
			// defaults are 60/min + concurrency 4 — see render-throttle.ts.
			//
			// Other render-touching tests (render-cache, render-etag,
			// render-avif-dpr) deliberately use unique X-Forwarded-For
			// headers per-test so they don't exhaust each other's buckets;
			// the throttle test itself uses 127.0.0.1 directly.
			RENDER_RATE_PER_MIN: '5',
			RENDER_CONCURRENCY: '2',
			RENDER_QUEUE_TIMEOUT_MS: '500'
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
