/**
 * Full happy path — the "non-technical creator can do this" claim, automated.
 *
 * Signup → new canvas → editor → text + image layer → bind a text param →
 * preview → publish → 'Using this template' panel → fetch share URL as a
 * bot (assert og:image meta) → fetch image URL (assert image/png).
 *
 * If this passes, every shipped layer of the product is talking to every
 * other layer correctly. If a v0.3+ change breaks the headline use case,
 * this is the single test that should fail.
 */
import { test, expect } from '@playwright/test';
import {
	signupAndLogin,
	createCanvas,
	gotoEditor,
	addTextLayer,
	addImageLayer,
	bindParam,
	publish,
	uniqueXffHeaders
} from './helpers';

const TINY_PNG = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
		'0000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082',
	'hex'
);

test('full happy path — signup to share URL, bot meta, image render', async ({ page, request }) => {
	// 1. Signup → dashboard.
	await signupAndLogin(page);

	// 2. Dashboard empty state should be the marketing pitch + 'Try an example'
	// CTA shipped in TASK-33. We use the New Canvas path here (the "start from
	// scratch" branch); TASK-48 covers the empty-state copy regression.
	const newCanvasLink = page.getByRole('link', { name: 'New Canvas' });
	await expect(newCanvasLink).toBeVisible();

	const canvas = await createCanvas(page, {
		name: 'Happy Path Canvas',
		preset: 'OG Image'
	});
	await gotoEditor(page, canvas.id);

	// 3. Editor — text layer (bindable), then image layer for visual realism.
	await addTextLayer(page, 'Hello {{title}}');
	await addImageLayer(page, {
		name: 'pixel.png',
		mimeType: 'image/png',
		buffer: TINY_PNG
	});

	// 4. Add a second text layer and bind its content to ?title=.
	// (The image layer left selection on itself; addTextLayer re-selects to
	// the new text layer so bindParam's "Text Content" row is available.)
	await addTextLayer(page, 'Default subtitle');
	await bindParam(page, 'Text Content', 'title', 'Hello world');

	// 5. Preview panel — verify the "Test Parameters" surface picks up our
	// binding. The button label flips to "Close Preview" while open.
	await page.getByRole('button', { name: 'Preview' }).click();
	await expect(page.getByRole('button', { name: 'Close Preview' })).toBeVisible({
		timeout: 10_000
	});
	const testParam = page.getByLabel('title');
	await expect(testParam).toBeVisible();

	// 6. Publish via the toolbar → 'Using this template' panel renders.
	const { shareUrl, imageUrl } = await publish(page);
	expect(shareUrl).toMatch(/\/c\/[A-Za-z0-9-]+$/);
	expect(imageUrl).toMatch(/\/c\/[A-Za-z0-9-]+\/image\.png$/);
	await expect(page.getByRole('heading', { name: 'Using this template' })).toBeVisible();
	// The bound param appears in the docs table.
	await expect(page.getByText('title', { exact: true }).first()).toBeVisible();

	// 7. Bot UA on the share URL gets HTML with og:image meta tags.
	const botRes = await request.get(shareUrl, {
		headers: { 'user-agent': 'Twitterbot/1.0' }
	});
	expect(botRes.status()).toBe(200);
	const html = await botRes.text();
	expect(html).toContain('og:image');
	expect(html).toContain('twitter:card');

	// 8. Image URL renders a PNG with the bound param applied.
	const imgRes = await request.get(`${imageUrl}?title=Custom`, { headers: uniqueXffHeaders() });
	expect(imgRes.status()).toBe(200);
	expect(imgRes.headers()['content-type']).toBe('image/png');
	expect((await imgRes.body()).length).toBeGreaterThan(100);
});
