/**
 * Slug rename UI in PublishModal (TASK-98).
 *
 * The server side (PATCH /api/canvas/:id with `slug`) already shipped
 * in TASK-92. These tests cover the editor UI: live format validation,
 * server-side collision feedback with one-click "Use suggestion"
 * acceptance, and that a successful rename ripples to share/image
 * URLs across the editor without a page reload.
 */
import { test, expect } from '@playwright/test';
import {
	signupAndLogin,
	createCanvas,
	gotoEditor,
	addTextLayer,
	publish,
	uniqueXffHeaders
} from './helpers';

test('slug rename: format validation, successful rename, URLs ripple', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Slug Rename', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	const { shareUrl: oldShareUrl } = await publish(page);

	const slugInput = page.getByTestId('slug-input');
	await expect(slugInput).toBeVisible();

	// Live format validation on bad input — no PATCH should fire.
	await slugInput.fill('Has Spaces');
	await expect(page.getByTestId('slug-format-error')).toBeVisible();
	await expect(page.getByTestId('slug-format-error')).toContainText('lowercase');

	// Valid rename. Use a unique target so this run doesn't clash with
	// any leftover slug from a previous run on the same DB.
	const newSlug = `lp-card-${Date.now()}`;
	await slugInput.fill(newSlug);
	await expect(page.getByTestId('slug-format-error')).toBeHidden();
	await slugInput.blur();

	// Wait for the PATCH to settle. The share-page URL input flips to
	// the new slug after the rename ripples up to the editor.
	await expect(async () => {
		const shareUrlInput = page.locator('#publish-share-url');
		expect(await shareUrlInput.inputValue()).toContain(`/c/${newSlug}`);
	}).toPass({ timeout: 5_000 });

	// Image URL also ripples.
	expect(await page.locator('#publish-image-url').inputValue()).toContain(`/c/${newSlug}`);

	// Old URL 404s; new URL serves the published canvas.
	const oldRes = await request.get(oldShareUrl);
	expect(oldRes.status()).toBe(404);
	const newShareUrl = oldShareUrl.replace(/\/c\/[^/?]+/, `/c/${newSlug}`);
	const newRes = await request.get(newShareUrl, { headers: { 'user-agent': 'Twitterbot/1.0' } });
	expect(newRes.status()).toBe(200);
});

test('slug rename: 409 on collision shows server message + clickable suggestion', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);

	// Create a canvas A so its slug is taken globally.
	const taken = `taken-${Date.now()}`;
	const canvasA = await (await page.request.post('/api/canvas', { data: { name: taken } })).json();
	expect(canvasA.slug).toBe(taken);

	// Create canvas B and try to rename it to A's slug via the modal.
	const canvasB = await createCanvas(page, { name: 'Renamer', preset: 'OG Image' });
	await gotoEditor(page, canvasB.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	const slugInput = page.getByTestId('slug-input');
	await slugInput.fill(taken);
	await slugInput.blur();

	const error = page.getByTestId('slug-server-error');
	await expect(error).toBeVisible();
	await expect(error).toContainText('already in use');

	const apply = page.getByTestId('slug-suggestion-apply');
	await expect(apply).toBeVisible();
	await expect(apply).toContainText(`${taken}-2`);

	// One-click acceptance: pressing the button fires another PATCH
	// and the share URL ripples to `${taken}-2`.
	await apply.click();
	await expect(async () => {
		expect(await page.locator('#publish-share-url').inputValue()).toContain(`/c/${taken}-2`);
	}).toPass({ timeout: 5_000 });

	// Server confirms the slug is now in fact `${taken}-2`.
	const r = await request.get(`/api/canvas/${canvasB.id}`);
	const body = (await r.json()) as { slug: string };
	expect(body.slug).toBe(`${taken}-2`);
});

test('slug rename: Enter-submitted collision lets user click suggestion without losing it (Codex round 2 P3)', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);

	const taken = `enter-${Date.now()}`;
	await page.request.post('/api/canvas', { data: { name: taken } });

	const canvas = await createCanvas(page, { name: 'Enter Submit', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	// Submit with Enter (input remains focused). The 409 surfaces with
	// the suggestion button. Without the mousedown-preventDefault fix,
	// clicking the button would blur the input first → commitSlugRename
	// runs again on the still-colliding draft → suggestion is cleared
	// before the click handler runs.
	const slugInput = page.getByTestId('slug-input');
	await slugInput.focus();
	await slugInput.fill(taken);
	await slugInput.press('Enter');
	const apply = page.getByTestId('slug-suggestion-apply');
	await expect(apply).toBeVisible();

	// Click the button. It should commit `${taken}-2`.
	await apply.click();
	await expect(async () => {
		expect(await page.locator('#publish-share-url').inputValue()).toContain(`/c/${taken}-2`);
	}).toPass({ timeout: 5_000 });
	const r = await request.get(`/api/canvas/${canvas.id}`);
	const body = (await r.json()) as { slug: string };
	expect(body.slug).toBe(`${taken}-2`);
});

test('slug rename: closing modal with invalid draft resets state on reopen (Codex round 1 P3)', async ({
	page
}) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Slug reset', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	const slugInput = page.getByTestId('slug-input');
	const startingSlug = await slugInput.inputValue();
	expect(startingSlug.length).toBeGreaterThan(0);

	// Type an invalid value so the format error shows.
	await slugInput.fill('Bad Value');
	await expect(page.getByTestId('slug-format-error')).toBeVisible();

	// Dismiss the modal — Esc is the project's universal modal close.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sharing-section')).toBeHidden();

	// Reopen.
	await page.getByTestId('toolbar-publish').click();
	await expect(page.getByTestId('sharing-section')).toBeVisible();

	// Draft is back to the canonical slug; format error is cleared.
	await expect(page.getByTestId('slug-input')).toHaveValue(startingSlug);
	await expect(page.getByTestId('slug-format-error')).toBeHidden();
	await expect(page.getByTestId('slug-server-error')).toBeHidden();
});

test('slug rename: image URL with new slug renders 200 (cache key uses new slug)', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Slug cache', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	const newSlug = `slug-cache-${Date.now()}`;
	await page.getByTestId('slug-input').fill(newSlug);
	await page.getByTestId('slug-input').blur();
	await expect(async () => {
		expect(await page.locator('#publish-image-url').inputValue()).toContain(`/c/${newSlug}`);
	}).toPass({ timeout: 5_000 });

	// Render route accepts the new slug and returns a PNG.
	const res = await request.get(`/c/${newSlug}/image.png`, { headers: uniqueXffHeaders() });
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toBe('image/png');
});
