/**
 * OG meta polish (TASK-97).
 *
 * Asserts the share page emits og:url + og:image:type, the OG embed
 * snippet in PublishModal includes the same fields, and the
 * "Test on social" validator buttons link to the right tool URLs.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer, publish } from './helpers';

function metaContent(html: string, property: string): string | null {
	const re = new RegExp(
		`<meta[^>]+property="${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]+content="([^"]*)"`
	);
	const match = html.match(re);
	return match ? match[1] : null;
}

test('share page emits og:url and og:image:type', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'OG meta polish', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	const { shareUrl } = await publish(page);

	const res = await request.get(shareUrl, { headers: { 'user-agent': 'Twitterbot/1.0' } });
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(metaContent(html, 'og:image:type')).toBe('image/png');

	const ogUrl = metaContent(html, 'og:url');
	expect(ogUrl).not.toBeNull();
	// Canonical share URL — same shape as `shareUrl` (no `_v` token).
	expect(ogUrl).toBe(shareUrl);
});

test('og:url preserves user-supplied query params', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'OG canonical', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	const { shareUrl } = await publish(page);

	const res = await request.get(`${shareUrl}?title=hi&utm=tw`, {
		headers: { 'user-agent': 'Twitterbot/1.0' }
	});
	const html = await res.text();
	const ogUrl = metaContent(html, 'og:url');
	expect(ogUrl).toContain('title=hi');
	expect(ogUrl).toContain('utm=tw');
	// Underscore-prefixed reserved flags are stripped from the canonical.
	expect(ogUrl).not.toContain('_v=');
});

test('PublishModal OG embed snippet includes og:url + og:image:type', async ({ page }) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'OG snippet', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	// Switch to the OG meta tab. The snippet lives in a textarea, so
	// the asserted content is the input value, not the rendered text.
	await page.getByTestId('embed-tab-og').click();
	const snippet = page.getByTestId('embed-snippet');
	const value = await snippet.inputValue();
	expect(value).toContain('og:image:type');
	expect(value).toContain('image/png');
	expect(value).toContain('og:url');
});

test('Test-on-social buttons link to the right validators with the share URL', async ({ page }) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Validators', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	const { shareUrl } = await publish(page);

	await expect(page.getByTestId('validator-section')).toBeVisible();
	const encoded = encodeURIComponent(shareUrl);
	await expect(page.getByTestId('validator-twitter')).toHaveAttribute(
		'href',
		`https://cards-dev.twitter.com/validator?url=${encoded}`
	);
	await expect(page.getByTestId('validator-facebook')).toHaveAttribute(
		'href',
		`https://developers.facebook.com/tools/debug/?q=${encoded}`
	);
	await expect(page.getByTestId('validator-linkedin')).toHaveAttribute(
		'href',
		`https://www.linkedin.com/post-inspector/inspect/${encoded}`
	);
});
