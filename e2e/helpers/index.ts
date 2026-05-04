/**
 * Reusable helpers for Canvas browser E2E tests.
 *
 * Each helper is one async function that drives the UI as a user would —
 * stable selectors first (roles, labels, ids), data-testid only where the
 * DOM doesn't expose anything reliable. Helpers are explicitly *not*
 * test fixtures: callers pass `page` so a single test can mix flows.
 *
 * Acceptance reference: see e2e/helpers.test.ts which uses every helper.
 */
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** A unique-per-test email so concurrent tests don't collide on the
 *  unique-email constraint. Date.now() + random keeps it readable. */
export function uniqueEmail(prefix = 'e2e'): string {
	return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
}

/**
 * Generate a unique `X-Forwarded-For` header value for a single test so
 * the public render route's per-IP rate limit treats it as a fresh
 * client. Without this every render-touching test would share one bucket
 * (127.0.0.1) and exhaust each other's quotas across the suite.
 *
 * Returns a header object suitable for `request.get(url, { headers })`.
 */
export function uniqueXffHeaders(): Record<string, string> {
	const a = 10;
	const b = Math.floor(Math.random() * 256);
	const c = Math.floor(Math.random() * 256);
	const d = Math.floor(Math.random() * 256);
	return { 'X-Forwarded-For': `${a}.${b}.${c}.${d}` };
}

export interface SignupOptions {
	name?: string;
	email?: string;
	password?: string;
}

/**
 * Sign up a brand-new user via the /signup form and wait for the resulting
 * navigation to the dashboard. Returns the credentials used so callers can
 * log back in later if they need to.
 */
export async function signupAndLogin(
	page: Page,
	opts: SignupOptions = {}
): Promise<Required<SignupOptions>> {
	const credentials = {
		name: opts.name ?? 'E2E Tester',
		email: opts.email ?? uniqueEmail(),
		password: opts.password ?? 'testpass123456'
	};

	await page.goto('/signup');
	// Wait for SvelteKit to hydrate before interacting. Without this the
	// click fires before the form's onsubmit listener attaches, the
	// browser's native GET submit runs (URL becomes /signup?), and the
	// JS-driven goto('/') after auth never happens. networkidle is the
	// reliable cross-route signal that the JS bundle has loaded.
	await page.waitForLoadState('networkidle');
	// Use accessible name (label text) — it's stable across CSS refactors.
	await page.getByLabel('Name').fill(credentials.name);
	await page.getByLabel('Email').fill(credentials.email);
	await page.getByLabel('Password').fill(credentials.password);
	await page.getByRole('button', { name: 'Sign up' }).click();

	// /signup pushes to / on success. Waiting on the URL is more reliable
	// than waiting on a specific dashboard selector since the empty-state
	// and populated-state paint differently.
	await page.waitForURL('/', { timeout: 10_000 });
	return credentials;
}

export interface CreateCanvasOptions {
	name?: string;
	preset?: 'OG Image' | 'Twitter Card' | 'Instagram Post' | 'Custom';
	customWidth?: number;
	customHeight?: number;
	backgroundColor?: string;
}

/**
 * Walk the /new form to create a canvas, then wait for the resulting
 * editor page. Returns the canvas id parsed from the URL so callers can
 * round-trip through the API or build subsequent URLs.
 */
export async function createCanvas(
	page: Page,
	opts: CreateCanvasOptions = {}
): Promise<{ id: string; name: string }> {
	const name = opts.name ?? `E2E Canvas ${Date.now()}`;
	const preset = opts.preset ?? 'OG Image';

	await page.goto('/new');
	// Same hydration discipline as signupAndLogin — wait for SvelteKit to
	// attach event handlers before clicking. The /new form's submit button
	// otherwise triggers a native GET to /new?, the JS-driven goto to the
	// editor never happens, and waitForURL eventually times out.
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Name').fill(name);
	// Preset is a radio whose visible label includes the size (e.g.
	// "OG Image 1200×630"). Match by exact preset prefix to avoid coupling
	// to the formatting of the size suffix.
	await page.getByRole('radio', { name: new RegExp(`^${preset}\\b`) }).check();

	if (preset === 'Custom') {
		if (opts.customWidth !== undefined) {
			await page.getByLabel('Width').fill(String(opts.customWidth));
		}
		if (opts.customHeight !== undefined) {
			await page.getByLabel('Height').fill(String(opts.customHeight));
		}
	}

	if (opts.backgroundColor) {
		// <input type="color"> is fiddly to drive via .fill() in Chromium —
		// programmatically dispatch an input event with the new value.
		await page.locator('input[type="color"]').evaluate((el, v) => {
			(el as HTMLInputElement).value = v;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
		}, opts.backgroundColor);
	}

	await page.getByRole('button', { name: 'Create Canvas' }).click();

	// Editor URL is /canvas/{uuid}/edit. Wait for it before extracting id.
	await page.waitForURL(/\/canvas\/[^/]+\/edit$/, { timeout: 10_000 });
	const match = page.url().match(/\/canvas\/([^/]+)\/edit$/);
	if (!match) throw new Error(`Could not parse canvas id from URL: ${page.url()}`);
	return { id: match[1], name };
}

/** Navigate directly to an existing canvas's editor. */
export async function gotoEditor(page: Page, canvasId: string): Promise<void> {
	await page.goto(`/canvas/${canvasId}/edit`);
	// Wait until the toolbar element is in the DOM, then for hydration
	// (network idle) so Svelte's onclick handlers and editorRef binding
	// are wired up. Without the second wait, clicks on toolbar buttons
	// can land before editorRef is bound and silently no-op.
	await expect(page.getByTestId('editor-toolbar')).toBeVisible({ timeout: 10_000 });
	await page.waitForLoadState('networkidle');
}

/**
 * Add a Text layer via the toolbar and (if `text` is supplied) replace its
 * content via the property panel. Returns when the panel reflects the new
 * value, so subsequent assertions can rely on the change being committed.
 */
export async function addTextLayer(page: Page, text?: string): Promise<void> {
	await page.getByTestId('toolbar-add-text').click();
	// The new text object is auto-selected, so the property panel renders
	// immediately. Wait for the Content textarea to appear before typing.
	const contentField = page.getByLabel('Content');
	await expect(contentField).toBeVisible({ timeout: 5_000 });
	if (text !== undefined) {
		await contentField.fill(text);
		// Property panel commits on input — give Fabric a tick to repaint
		// and the autosave debounce a moment to settle.
		await expect(contentField).toHaveValue(text);
	}
}

/**
 * Add an image layer via the toolbar's hidden file input. Accepts a file
 * buffer + MIME so callers don't need to ship test fixtures on disk.
 */
export async function addImageLayer(
	page: Page,
	file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	// As of TASK-62 the toolbar Image button opens an Add Image modal
	// (Upload / From library tabs) instead of triggering a file input
	// directly. We open the modal, then drive the modal's hidden input.
	await page.getByTestId('toolbar-add-image').click();
	// The Upload tab is the default; setInputFiles works on the modal's
	// hidden file input even though it's display:none.
	const fileInput = page.locator('input[type="file"]');
	await expect(fileInput).toHaveCount(1);
	// Snapshot the layer count before upload so we can wait for it to
	// increment. Polling on the toolbar text is unreliable: 'Image' is
	// already the toolbar label before upload starts, so a too-fast
	// transition through 'Uploading…' would be missed and the helper
	// could return before Fabric has inserted the new layer.
	const layerList = page.getByRole('listbox', { name: 'Canvas layers' });
	const before = await layerList.locator('[role="option"]').count();
	await fileInput.setInputFiles(file);
	// Wait for the layer count to actually increase. This is the only
	// signal that observably correlates with the post-insert state of
	// the Fabric canvas, regardless of upload speed.
	await expect(async () => {
		const after = await layerList.locator('[role="option"]').count();
		expect(after).toBe(before + 1);
	}).toPass({ timeout: 15_000 });
}

/**
 * Bind a property of the currently-selected layer to a URL parameter via
 * the property panel's "Dynamic Parameters" section. `bindableLabel` is
 * the visible row label (e.g. "Text Content", "Fill Color", "Image Source").
 */
export async function bindParam(
	page: Page,
	bindableLabel: string,
	paramName: string,
	defaultValue?: string
): Promise<void> {
	// Expand the Dynamic Parameters section if it's collapsed. The header
	// is a button with aria-expanded; click only when collapsed so we
	// don't accidentally toggle it closed when the section is already open.
	const dynamicHeader = page.getByRole('button', { name: /Dynamic Parameters/ });
	const expanded = await dynamicHeader.getAttribute('aria-expanded');
	if (expanded !== 'true') {
		await dynamicHeader.click();
	}

	// Each bindable property is its own row. The Bind button has an
	// accessible name that varies by state ("Bind <Label> to a URL parameter"
	// when off, "Stop binding <Label>" when on). Match the off-state name
	// to find the right row, regardless of whether the user has bound
	// other properties already.
	const bindBtn = page.getByRole('button', {
		name: `Bind ${bindableLabel} to a URL parameter`
	});
	await bindBtn.click();

	// After clicking Bind, the panel renders the param-name input.
	const paramInput = page.getByLabel('Param name').first();
	await expect(paramInput).toBeVisible({ timeout: 3_000 });
	await paramInput.fill(paramName);

	if (defaultValue !== undefined) {
		const defaultInput = page.getByLabel('Default').first();
		await defaultInput.fill(defaultValue);
	}
}

/**
 * Open the Publish modal and confirm the publish, then wait for the
 * post-publish state. Returns the share URL the modal exposes.
 */
export async function publish(page: Page): Promise<{ shareUrl: string; imageUrl: string }> {
	await page.getByTestId('toolbar-publish').click();
	// PublishModal renders with a "Publish canvas" CTA in the unpublished
	// branch; clicking it triggers onBeforePublish (autosave flush) +
	// PATCH ?published=true.
	const confirmBtn = page.getByRole('button', { name: 'Publish canvas' });
	await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
	await confirmBtn.click();

	// On success the modal flips to the published branch (Share page URL
	// + Image URL fields).
	// exact: true so 'Image URL' doesn't also match 'Example image URL'.
	const shareInput = page.getByLabel('Share page URL', { exact: true });
	const imageInput = page.getByLabel('Image URL', { exact: true });
	await expect(shareInput).toBeVisible({ timeout: 10_000 });
	const shareUrl = await shareInput.inputValue();
	const imageUrl = await imageInput.inputValue();
	return { shareUrl, imageUrl };
}

/**
 * Read the share URL from an already-open Publish modal. Distinct from
 * publish() so tests can assert against the URL repeatedly without
 * re-issuing the publish action.
 */
export async function copyShareUrl(page: Page): Promise<string> {
	const shareInput = page.getByLabel('Share page URL', { exact: true });
	await expect(shareInput).toBeVisible();
	return shareInput.inputValue();
}
