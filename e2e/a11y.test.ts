/**
 * Automated a11y smoke (TASK-147).
 *
 * Runs axe-core (via `@axe-core/playwright`) against the main
 * user-facing routes and fails on `serious` or `critical` violations.
 * `moderate` / `minor` are reported via test stdout but do NOT fail
 * the build — the audit's framing is "establish a floor, don't
 * gold-plate", and we'll add a follow-up task per moderate/minor
 * cluster as triage uncovers things worth fixing.
 *
 * Routes covered (one test per route so a single failure doesn't
 * cascade and we can see which surface broke):
 *
 *   - `/`             public landing
 *   - `/login`        auth shell
 *   - `/signup`       auth shell
 *   - `/dashboard`    primary authed entry point
 *   - `/templates`    discovery
 *   - `/assets`       library
 *   - `/c/{slug}`     public share landing (no redirect set; the
 *                      interstitial shape — TASK-139)
 *
 * The editor route (`/canvas/{id}/edit`) is intentionally excluded
 * from this initial smoke. It's MobileBanner-blocked at <960px, has
 * heavy canvas + property-panel chrome whose a11y story warrants its
 * own focused task, and would balloon the diff. Follow-up will
 * cover it separately under TASK-115.
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas } from './helpers';

/**
 * Severities axe assigns: `minor`, `moderate`, `serious`, `critical`.
 * We fail on the upper two — those are the ones the audit calls "a11y
 * floor" violations (e.g., missing label on a focusable control,
 * insufficient color contrast on body text, missing landmark).
 *
 * `moderate` covers things like "image alt could be more descriptive"
 * that often need product judgment rather than mechanical fixes.
 * Surfacing them via stdout keeps them visible without making the
 * suite red on every PR.
 */
const FAIL_SEVERITIES = ['serious', 'critical'] as const;
const LOG_SEVERITIES = ['moderate', 'minor'] as const;

interface AxeViolation {
	id: string;
	impact: string | null | undefined;
	help: string;
	helpUrl: string;
	nodes: { target: unknown[]; html: string }[];
}

/**
 * Run axe against the current page and partition violations by
 * severity. Fails the test if any violation has impact in
 * FAIL_SEVERITIES. Always logs the full violation summary so a
 * passing test still reports what wasn't blocking.
 *
 * Axe's `analyze` reads the live DOM, so callers must drive the page
 * to a steady state (URL navigated, dynamic content hydrated) before
 * calling this. For most routes a `page.goto` + a single
 * `expect(page.locator(...)).toBeVisible()` is sufficient.
 */
async function expectNoA11yViolations(
	page: import('@playwright/test').Page,
	label: string
): Promise<void> {
	// Exclude the canvas element's role=application from rule scope.
	// Fabric renders into a bare <canvas>; axe's image-related rules
	// (image-alt) fire on it because it's an interactive surface
	// without a textual alternative. This is intentional — the
	// underlying canvas IS the editor surface and a textual
	// description doesn't represent its state. Editor a11y is its
	// own focused effort under TASK-115's follow-up.
	const results = await new AxeBuilder({ page })
		.exclude('canvas')
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();

	const violations = results.violations as AxeViolation[];
	const blocking = violations.filter((v) =>
		FAIL_SEVERITIES.includes((v.impact ?? '') as (typeof FAIL_SEVERITIES)[number])
	);
	const informational = violations.filter((v) =>
		LOG_SEVERITIES.includes((v.impact ?? '') as (typeof LOG_SEVERITIES)[number])
	);

	if (informational.length > 0) {
		// Print to stdout so it surfaces in CI logs without failing the
		// run. The matrix lists severity, rule id, count of failing
		// nodes, and the first failing snippet — enough to triage.
		console.log(
			`[a11y/${label}] ${informational.length} non-blocking violation(s):` +
				informational
					.map(
						(v) =>
							`\n  - [${v.impact}] ${v.id} (${v.nodes.length} node(s)) — ${v.help} — ${v.helpUrl}`
					)
					.join('')
		);
	}

	if (blocking.length > 0) {
		// Build a detailed failure message so the dev fixing it
		// doesn't have to rerun + dig through axe internals to see
		// what triggered.
		const detail = blocking
			.map(
				(v) =>
					`\n  - [${v.impact}] ${v.id} (${v.nodes.length} node(s))\n    ${v.help}\n    ${v.helpUrl}\n    first node: ${v.nodes[0]?.html?.slice(0, 200) ?? '(unknown)'}`
			)
			.join('');
		expect(blocking, `[a11y/${label}] blocking violations:${detail}`).toEqual([]);
	}
}

test.describe('A11y smoke (axe-core)', () => {
	test('public landing /', async ({ page }) => {
		await page.goto('/');
		// Route-specific readiness check (Codex round 2 P3) — matching
		// the landing's hero copy rather than `level: 1` so a
		// rendered SvelteKit error page (which also has an H1) can't
		// satisfy the gate.
		await expect(page.getByRole('heading', { name: /Tweet a dynamic image/i })).toBeVisible();
		await expectNoA11yViolations(page, 'landing');
	});

	test('/login', async ({ page }) => {
		await page.goto('/login');
		await expect(page.getByLabel('Email')).toBeVisible();
		await expectNoA11yViolations(page, 'login');
	});

	test('/signup', async ({ page }) => {
		await page.goto('/signup');
		await expect(page.getByLabel('Name')).toBeVisible();
		await expectNoA11yViolations(page, 'signup');
	});

	test('/dashboard (authed, empty)', async ({ page }) => {
		await signupAndLogin(page);
		// signupAndLogin already lands on /dashboard. Empty-state surface.
		// Route-specific readiness check (Codex round 2 P3) — the shared
		// nav also renders on the app's error boundary, so we wait on
		// the dashboard's own H1 to confirm we're actually on the
		// dashboard page (not an error fallback).
		await expect(page.getByRole('heading', { name: 'Your Canvases' })).toBeVisible();
		await expectNoA11yViolations(page, 'dashboard-empty');
	});

	test('/dashboard (authed, populated)', async ({ page }) => {
		await signupAndLogin(page);
		await createCanvas(page, { name: 'A11y populated' });
		// Navigate back to dashboard to render the populated state.
		await page.getByTestId('nav-dashboard').click();
		await page.waitForURL('/dashboard');
		// Route-specific readiness — the H1 confirms we're on the
		// dashboard route, and the card confirms the populated state.
		await expect(page.getByRole('heading', { name: 'Your Canvases' })).toBeVisible();
		await expect(page.locator('[data-testid="canvas-card"]').first()).toBeVisible();
		await expectNoA11yViolations(page, 'dashboard-populated');
	});

	test('/templates', async ({ page }) => {
		await signupAndLogin(page);
		await page.getByTestId('nav-templates').click();
		await page.waitForURL('/templates');
		await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
		await expectNoA11yViolations(page, 'templates');
	});

	test('/assets', async ({ page }) => {
		await signupAndLogin(page);
		await page.getByTestId('nav-assets').click();
		await page.waitForURL('/assets');
		// Route-specific readiness check (Codex round 1 P3) — a load
		// failure could leave the URL at /assets while rendering the
		// app's error boundary, which would let axe scan the error
		// page instead of the actual route.
		await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
		await expectNoA11yViolations(page, 'assets');
	});

	test('public share landing /c/{slug} (no redirect)', async ({ page, request }) => {
		// Sign up + create + publish a canvas via the API so we land
		// directly on the public surface without going through the editor
		// (whose canvas-heavy DOM is out of scope for this smoke).
		//
		// Each API call is asserted (Codex round 1 P2) so a setup
		// failure surfaces immediately as a test failure — otherwise
		// `canvas.slug` could land as `undefined`, the goto would hit
		// the app's error page (which has its own H1), and axe would
		// false-positive-pass against an unrelated route.
		const shareName = `A11y share ${Date.now()}`;
		const signupRes = await request.post('/api/auth/sign-up/email', {
			data: {
				name: 'A11y Share',
				email: `a11y-share-${Date.now()}@test.com`,
				password: 'testpass123456'
			}
		});
		expect(signupRes.status()).toBe(200);
		const cookies = signupRes.headers()['set-cookie'] || '';

		const createRes = await request.post('/api/canvas', {
			data: { name: shareName, width: 1200, height: 630 },
			headers: { cookie: cookies }
		});
		expect(createRes.status()).toBe(201);
		const canvas = (await createRes.json()) as { id: string; slug: string };
		expect(canvas.slug).toBeTruthy();

		const patchRes = await request.patch(`/api/canvas/${canvas.id}`, {
			data: { published: true },
			headers: { cookie: cookies }
		});
		expect(patchRes.status()).toBe(200);

		await page.goto(`/c/${canvas.slug}`);
		// Route-specific readiness assertion — the share landing renders
		// the canvas name as its H1 (TASK-139). Matching by content
		// rather than level=1 alone protects against a false pass when
		// the app's error page (also has H1) is rendered instead.
		await expect(page.getByRole('heading', { name: shareName })).toBeVisible();
		await expectNoA11yViolations(page, 'share-landing');
	});
});
