/**
 * PublishModal "Sharing & redirect" section (TASK-95).
 *
 * The OG title / OG description / redirect URL fields existed in the
 * canvases schema and PATCH endpoint but had no UI surface before
 * TASK-95. These tests assert the round-trip: enter a value → blur →
 * the share page (bot UA) reflects it / human UA gets the 302.
 *
 * Use `page.request` (not the standalone `request` fixture) so calls
 * carry the signed-in browser-context cookies.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer, publish } from './helpers';

test('OG title and description from PublishModal land on the share page', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'OG editable', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	const { shareUrl } = await publish(page);

	// PublishModal stays open after publish — the new section is visible.
	await expect(page.getByTestId('sharing-section')).toBeVisible();

	const titleInput = page.getByTestId('og-title-input');
	const descInput = page.getByTestId('og-description-input');

	await titleInput.fill('My custom OG title');
	await titleInput.blur();
	await descInput.fill('A description for crawlers');
	await descInput.blur();

	// Wait for the PATCH(es) to settle by polling /api/canvas/:id.
	await expect(async () => {
		const r = await request.get(`/api/canvas/${canvas.id}`);
		expect(r.status()).toBe(200);
		const data = (await r.json()) as { ogTitle: string; ogDescription: string };
		expect(data.ogTitle).toBe('My custom OG title');
		expect(data.ogDescription).toBe('A description for crawlers');
	}).toPass({ timeout: 5_000 });

	// Bot UA on the share URL receives the new values in og:title / og:description.
	const botRes = await request.get(shareUrl, { headers: { 'user-agent': 'Twitterbot/1.0' } });
	expect(botRes.status()).toBe(200);
	const html = await botRes.text();
	expect(html).toContain('My custom OG title');
	expect(html).toContain('A description for crawlers');
});

test('Redirect URL set in PublishModal sends humans to the configured destination', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Redirect editable', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	const { shareUrl } = await publish(page);

	const target = 'https://example.com/landing';
	const redirectInput = page.getByTestId('redirect-url-input');
	await redirectInput.fill(target);
	await redirectInput.blur();

	await expect(async () => {
		const r = await request.get(`/api/canvas/${canvas.id}`);
		const data = (await r.json()) as { redirectUrl: string };
		expect(data.redirectUrl).toBe(target);
	}).toPass({ timeout: 5_000 });

	// Human UA gets a 302 to the configured target. Disable redirect
	// following so we can assert on the redirect itself.
	const human = await request.get(shareUrl, {
		headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
		maxRedirects: 0
	});
	expect(human.status()).toBe(302);
	expect(human.headers()['location']).toBe(target);
});

test('Reopening the modal pre-fills the saved sharing values', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'OG persisted', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	await page.getByTestId('og-title-input').fill('Persisted title');
	await page.getByTestId('og-title-input').blur();
	await expect(async () => {
		const r = await request.get(`/api/canvas/${canvas.id}`);
		const data = (await r.json()) as { ogTitle: string };
		expect(data.ogTitle).toBe('Persisted title');
	}).toPass({ timeout: 5_000 });

	// Close the modal — Escape is the project's universal modal dismiss.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sharing-section')).toBeHidden();

	// Re-open via the toolbar's Publish button. Already-published →
	// the modal lands on the share/edit branch.
	await page.getByTestId('toolbar-publish').click();
	await expect(page.getByTestId('sharing-section')).toBeVisible();
	await expect(page.getByTestId('og-title-input')).toHaveValue('Persisted title');
});
