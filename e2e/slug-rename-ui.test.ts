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

test('slug rename: Tab from input to suggestion button preserves the suggestion (Codex round 3 P3)', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);

	const taken = `tab-${Date.now()}`;
	await page.request.post('/api/canvas', { data: { name: taken } });

	const canvas = await createCanvas(page, { name: 'Tab Suggest', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	const slugInput = page.getByTestId('slug-input');
	await slugInput.focus();
	await slugInput.fill(taken);
	await slugInput.press('Enter');

	const apply = page.getByTestId('slug-suggestion-apply');
	await expect(apply).toBeVisible();

	// Pressing Tab moves focus off the input. Without the lastFailed
	// guard, blur fires commit on the still-colliding draft and clears
	// the suggestion before Tab focus lands on the button.
	await slugInput.press('Tab');
	await expect(apply).toBeVisible();

	// The button is now focusable; activating with Enter applies the
	// suggestion (the click handler is fine via keyboard too because
	// onmousedown isn't triggered, and the input no longer has focus
	// to blur-clear the suggestion).
	await apply.click();
	await expect(async () => {
		expect(await page.locator('#publish-share-url').inputValue()).toContain(`/c/${taken}-2`);
	}).toPass({ timeout: 5_000 });
	const r = await request.get(`/api/canvas/${canvas.id}`);
	expect(((await r.json()) as { slug: string }).slug).toBe(`${taken}-2`);
});

test('slug rename: closing modal mid-flight still updates editor slug (Codex round 3 P2)', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Mid-flight close', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	const newSlug = `midflight-${Date.now()}`;
	const slugInput = page.getByTestId('slug-input');
	// Throttle the PATCH on the network layer so we can close the
	// modal while it's in flight. Playwright's route handler delays
	// the response by 1.5s — plenty of time to press Escape.
	await page.route(`**/api/canvas/${canvas.id}`, async (route) => {
		if (route.request().method() === 'PATCH') {
			await new Promise((r) => setTimeout(r, 1500));
		}
		await route.continue();
	});

	await slugInput.fill(newSlug);
	await slugInput.press('Enter');
	// Close the modal immediately — the PATCH is still in flight.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sharing-section')).toBeHidden();

	// Wait for the server to confirm the rename. Without the round-3
	// P2 fix, the modal's close-bumping the slug-rename generation
	// would have dropped onSlugChange — the editor's local mirror
	// would still show the old slug even though the server stored
	// the new one.
	await expect(async () => {
		const r = await request.get(`/api/canvas/${canvas.id}`);
		const body = (await r.json()) as { slug: string };
		expect(body.slug).toBe(newSlug);
	}).toPass({ timeout: 5_000 });

	// Reopen the modal — its share/image-URL inputs reflect the new
	// slug because the editor's `canvasSlug` mirror was updated by
	// the late onSlugChange.
	await page.getByTestId('toolbar-publish').click();
	await expect(page.getByTestId('sharing-section')).toBeVisible();
	await expect(page.locator('#publish-share-url')).toHaveValue(new RegExp(`/c/${newSlug}$`));
	await page.unroute(`**/api/canvas/${canvas.id}`);
});

test('slug rename: close-then-resubmit drops the earlier in-flight rename (Codex round 4 P2)', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Sequenced Renames', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	const slugA = `seq-a-${Date.now()}`;
	const slugB = `seq-b-${Date.now()}`;
	let patchesSeen = 0;

	// Delay the FIRST PATCH (slug A) so we can submit a SECOND one
	// (slug B) while it's still in flight. The second PATCH responds
	// quickly. Without the round-4 P2 fix, A's late success would
	// call onSlugChange(A), bump the generation, and drop B's
	// completion — leaving the editor showing slug A while the
	// server stored slug B.
	await page.route(`**/api/canvas/${canvas.id}`, async (route) => {
		if (route.request().method() === 'PATCH') {
			patchesSeen++;
			if (patchesSeen === 1) {
				await new Promise((r) => setTimeout(r, 1500));
			}
		}
		await route.continue();
	});

	const slugInput = page.getByTestId('slug-input');

	// 1. Submit slug A (slow PATCH starts).
	await slugInput.fill(slugA);
	await slugInput.press('Enter');

	// 2. Close + reopen modal mid-flight.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sharing-section')).toBeHidden();
	await page.getByTestId('toolbar-publish').click();
	await expect(page.getByTestId('sharing-section')).toBeVisible();

	// 3. Submit slug B (fast PATCH).
	await page.getByTestId('slug-input').fill(slugB);
	await page.getByTestId('slug-input').blur();

	// Both PATCHes have been issued. After the slow A completes, B
	// should be the canonical slug because B was submitted last.
	await expect(async () => {
		const r = await request.get(`/api/canvas/${canvas.id}`);
		const body = (await r.json()) as { slug: string };
		expect(body.slug).toBe(slugB);
	}).toPass({ timeout: 6_000 });

	// Editor's local mirror also reflects slug B (not slug A) once
	// both completions have landed.
	await expect(page.locator('#publish-share-url')).toHaveValue(new RegExp(`/c/${slugB}$`));
	await page.unroute(`**/api/canvas/${canvas.id}`);
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

test('slug rename: late 409 with close-then-quick-reopen still does not surface (Codex round 12 P2)', async ({
	page
}) => {
	// Close-then-quick-reopen scenario: the user closes the modal
	// while a colliding PATCH is still in flight, then reopens
	// before the 409 returns. `open` is true again, but the late
	// 409 is still tied to the previous UI session and must NOT
	// write into the fresh one.
	await signupAndLogin(page);

	const taken = `quick-${Date.now()}`;
	await page.request.post('/api/canvas', { data: { name: taken } });

	const canvas = await createCanvas(page, { name: 'Quick reopen', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	// Throttle the PATCH so the 409 lands AFTER close→reopen.
	await page.route(`**/api/canvas/${canvas.id}`, async (route) => {
		if (route.request().method() === 'PATCH') {
			await new Promise((r) => setTimeout(r, 1500));
		}
		await route.continue();
	});

	const slugInput = page.getByTestId('slug-input');
	await slugInput.fill(taken);
	await slugInput.press('Enter');
	// Close immediately.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sharing-section')).toBeHidden();
	// Reopen IMMEDIATELY (before the late 409 returns).
	await page.getByTestId('toolbar-publish').click();
	await expect(page.getByTestId('sharing-section')).toBeVisible();

	// Wait for the late 409 to land.
	await page.waitForTimeout(1800);

	// The late 409 must not have repopulated the new session's UI.
	await expect(page.getByTestId('slug-server-error')).toBeHidden();
	await expect(page.getByTestId('slug-suggestion-apply')).toBeHidden();
	await page.unroute(`**/api/canvas/${canvas.id}`);
});

test('slug rename: late 409 after close does not surface on reopen (Codex round 11 P2)', async ({
	page
}) => {
	await signupAndLogin(page);

	const taken = `late-${Date.now()}`;
	await page.request.post('/api/canvas', { data: { name: taken } });

	const canvas = await createCanvas(page, { name: 'Late close', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	// Throttle the PATCH so the 409 lands AFTER we close the modal.
	await page.route(`**/api/canvas/${canvas.id}`, async (route) => {
		if (route.request().method() === 'PATCH') {
			await new Promise((r) => setTimeout(r, 1500));
		}
		await route.continue();
	});

	const slugInput = page.getByTestId('slug-input');
	await slugInput.fill(taken);
	await slugInput.press('Enter');
	// Close immediately — the 409 hasn't returned yet.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sharing-section')).toBeHidden();

	// Wait long enough for the late 409 to land.
	await page.waitForTimeout(1800);

	// Reopen the modal. The stale 409 must NOT have repopulated
	// slugServerError / slugSuggestion.
	await page.getByTestId('toolbar-publish').click();
	await expect(page.getByTestId('sharing-section')).toBeVisible();
	await expect(page.getByTestId('slug-server-error')).toBeHidden();
	await expect(page.getByTestId('slug-suggestion-apply')).toBeHidden();
	await page.unroute(`**/api/canvas/${canvas.id}`);
});

test('slug rename: lazy version-fetch failure is retry-able with the same value (Codex round 9 P2)', async ({
	page
}) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Lazy retry', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');

	// Fail every GET so canvasVersion never loads. The first commit
	// will see "Couldn't read canvas version. Please try again."
	// We then unblock GETs and assert the user can retry the SAME
	// value — without the round-9 P2 fix, the slug is marked as
	// "lastFailed" and blur-commit short-circuits on subsequent
	// attempts even though the value never made it to the server.
	let blockGets = true;
	await page.route(`**/api/canvas/${canvas.id}`, async (route) => {
		if (route.request().method() === 'GET' && blockGets) {
			await route.fulfill({ status: 503, body: '' });
			return;
		}
		await route.continue();
	});
	await publish(page);

	const slugInput = page.getByTestId('slug-input');
	await expect(slugInput).toBeEnabled();
	const newSlug = `lazy-retry-${Date.now()}`;
	await slugInput.fill(newSlug);
	await slugInput.press('Enter');

	// First attempt surfaces the error.
	await expect(page.getByTestId('slug-server-error')).toBeVisible();

	// Unblock GETs and retry with the same value (no edit). With the
	// round-9 P2 fix, the lastFailed flag was NOT set, so commit
	// runs again. The lazy-fetch now succeeds, the rename lands.
	blockGets = false;
	await slugInput.press('Enter');

	await expect(async () => {
		const r = await page.request.get(`/api/canvas/${canvas.id}`);
		const body = (await r.json()) as { slug: string };
		expect(body.slug).toBe(newSlug);
	}).toPass({ timeout: 5_000 });
	await page.unroute(`**/api/canvas/${canvas.id}`);
});

test('slug rename: lazy-fetches version when canvasVersion not yet captured (Codex round 8 P2)', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Lazy version', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	// The slug input is no longer disabled while loadSharing is in
	// flight — commitSlugRename lazy-fetches the ETag if it doesn't
	// have one yet, so a transient GET failure (or a race with a
	// fast typist) doesn't permanently break the slug field. Hang
	// the first GET (loadSharing) so the lazy-fetch path is the
	// one that actually obtains the version for the rename.
	let getsObserved = 0;
	await page.route(`**/api/canvas/${canvas.id}`, async (route) => {
		if (route.request().method() === 'GET') {
			getsObserved++;
			if (getsObserved === 1) {
				await new Promise((r) => setTimeout(r, 2500));
			}
		}
		await route.continue();
	});
	await publish(page);

	// Type immediately — input is enabled even though loadSharing
	// is still in flight.
	const slugInput = page.getByTestId('slug-input');
	await expect(slugInput).toBeEnabled();
	const newSlug = `lazy-${Date.now()}`;
	await slugInput.fill(newSlug);
	await slugInput.press('Enter');

	// commit lazy-fetched a version, applied If-Match, succeeded.
	// Server confirms.
	await expect(async () => {
		const r = await request.get(`/api/canvas/${canvas.id}`);
		const body = (await r.json()) as { slug: string };
		expect(body.slug).toBe(newSlug);
	}).toPass({ timeout: 8_000 });
	await page.unroute(`**/api/canvas/${canvas.id}`);
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
