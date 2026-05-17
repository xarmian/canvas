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
	// JS-driven goto('/dashboard') after auth never happens. networkidle is
	// the reliable cross-route signal that the JS bundle has loaded.
	await page.waitForLoadState('networkidle');
	// Use accessible name (label text) — it's stable across CSS refactors.
	await page.getByLabel('Name').fill(credentials.name);
	await page.getByLabel('Email').fill(credentials.email);
	await page.getByLabel('Password').fill(credentials.password);
	await page.getByRole('button', { name: 'Sign up' }).click();

	// /signup pushes to /dashboard on success (the dashboard moved out
	// from `/` when the public landing page shipped — TASK-99). Waiting
	// on the URL is more reliable than waiting on a specific dashboard
	// selector since the empty-state and populated-state paint differently.
	await page.waitForURL('/dashboard', { timeout: 10_000 });
	return credentials;
}

export interface CreateCanvasOptions {
	name?: string;
	/** Preset radio name. Updated in TASK-102 alongside the on-page
	 *  rename ("OG Image" → "OG / Twitter", etc.). The strings here
	 *  are matched as `^${preset}\\b` against the radio's accessible
	 *  name, so they only need to be a unique prefix. */
	preset?: 'OG / Twitter' | 'Twitter card' | 'Instagram post' | 'Custom';
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
	const preset = opts.preset ?? 'OG / Twitter';

	await page.goto('/new');
	// Same hydration discipline as signupAndLogin — wait for SvelteKit to
	// attach event handlers before clicking. The /new form's submit button
	// otherwise triggers a native GET to /new?, the JS-driven goto to the
	// editor never happens, and waitForURL eventually times out.
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Name').fill(name);
	// Preset is a radio whose accessible name follows the pattern
	// "<label> [recommended] <description> <width>×<height>" (TASK-102).
	// Match the preset's exact prefix so we don't get tripped up by the
	// description text. Escape regex metacharacters (`/`, `+`, `.`) in
	// the preset string so labels like "OG / Twitter" produce a literal
	// match.
	const escapedPreset = preset.replace(/[\\/^$.*+?()[\]{}|]/g, '\\$&');
	await page.getByRole('radio', { name: new RegExp(`^${escapedPreset}\\b`) }).check();

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
 * Click Save and wait for the toolbar Save button to settle on the
 * 'saved' state (BT-160). Replaces the old `page.getByText('All changes
 * saved')` pattern: the standalone save-status pill was removed when
 * automatic debounced saves were turned off — the Save button now
 * doubles as the indicator, exposing `data-state` for assertions.
 *
 * Use this anywhere a test previously relied on autosave to flush or
 * needed to wait for a save to complete before navigating away (the
 * editor's beforeNavigate guard fires on any pending dirty state).
 */
export async function saveAndWait(page: Page, timeoutMs = 10_000): Promise<void> {
	const saveBtn = page.getByTestId('toolbar-save');
	// If the button is already 'saved', the canvas is clean — nothing to do.
	const state = await saveBtn.getAttribute('data-state');
	if (state !== 'saved') {
		// The Save button is disabled in the 'saved' state, so calling
		// click() when there's nothing to save would error. Guard above.
		await saveBtn.click();
	}
	await expect(saveBtn).toHaveAttribute('data-state', 'saved', { timeout: timeoutMs });
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
	//
	// `getByRole('textbox', { name: 'Content', exact: true })` rather than
	// `getByLabel('Content')` — TASK-156. The inline ⚡ binding affordance
	// shipped in TASK-148 added a sibling `<button aria-label="Make Text
	// Content dynamic">` on the same row as this textarea. `getByLabel`
	// does substring matching of accessible names, so it matched BOTH the
	// textarea (label "Content") and the bind button (aria-label contains
	// "Content"), tripping Playwright's strict-mode "resolved to 2
	// elements" error and silently breaking every spec that called this
	// helper (3 in editor.test.ts, 1 in binding.test.ts, 1 in
	// keyboard-shortcuts.test.ts). Exact-match role lookup is unambiguous.
	const contentField = page.getByRole('textbox', { name: 'Content', exact: true });
	await expect(contentField).toBeVisible({ timeout: 5_000 });
	if (text !== undefined) {
		await contentField.fill(text);
		// Property panel commits on input — wait for the value to be reflected
		// back so subsequent assertions can rely on Fabric having repainted.
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
 * Bind a property of the currently-selected layer to a URL value via the
 * inline ⚡ affordance on the property panel. `bindableLabel` is the meta
 * label for the property (e.g. "Text Content", "Fill Color", "Image
 * Source", "Visibility", "Opacity", "Width", "Height").
 *
 * History — TASK-104 replaced the original "Dynamic Parameters" expandable
 * section + "Bind <Label> to a URL parameter" button pattern with the
 * inline ⚡ per-row affordance. TASK-141 renamed the bind editor's
 * "Param name" input label to "URL value name". This helper was rewritten
 * for the current UI in TASK-148.
 *
 * Flow:
 *   1. If the bindable lives inside the (collapsed-by-default) Position
 *      & size section, expand it so the property's ⚡ button is reachable.
 *   2. Click the ⚡ button (aria-label `Make <Label> dynamic`).
 *   3. Fill the bind editor's "URL value name" input.
 *   4. Optionally fill "Default".
 */
const POSITION_SECTION_LABELS = new Set([
	'Position X',
	'Position Y',
	'Width',
	'Height',
	'Opacity',
	'Visibility'
]);

export async function bindParam(
	page: Page,
	bindableLabel: string,
	paramName: string,
	defaultValue?: string
): Promise<void> {
	// Properties in the Position & size section need the section
	// expanded before their ⚡ button is in the DOM. The section
	// header is a button with aria-expanded; click only when
	// collapsed so we don't accidentally toggle it closed when a
	// previous helper call already opened it.
	if (POSITION_SECTION_LABELS.has(bindableLabel)) {
		const positionHeader = page.getByRole('button', { name: /^Position & size/ });
		const expanded = await positionHeader.getAttribute('aria-expanded');
		if (expanded !== 'true') {
			await positionHeader.click();
		}
	}

	// The ⚡ button has aria-label `Make <Label> dynamic` while unbound.
	// (When already bound it's `Edit dynamic value for <Label> …`, but
	// this helper is for the unbound case — re-binding through the same
	// path isn't a current caller need.) The button is `opacity: 0` until
	// row hover, but Playwright treats opacity:0 as visible for
	// actionability so the click still lands.
	const bindBtn = page.getByRole('button', { name: `Make ${bindableLabel} dynamic` });
	await bindBtn.click();

	// Only one bind editor is open at a time, so the label query is
	// unambiguous. `exact: true` avoids matching the conditional-rule
	// editor's `Rule {i} URL value name` aria-label (which contains
	// "URL value name" as a substring).
	const paramInput = page.getByLabel('URL value name', { exact: true });
	await expect(paramInput).toBeVisible({ timeout: 3_000 });
	await paramInput.fill(paramName);

	if (defaultValue !== undefined) {
		// Exact match for the bind editor's `<label>Default</label>`.
		// Defensive `.first()` against a future change that adds another
		// "Default" label to the panel.
		const defaultInput = page.getByLabel('Default', { exact: true }).first();
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
	// branch; clicking it triggers onBeforePublish (which flushes any
	// in-flight save and saves any pending edits) + PATCH ?published=true.
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
