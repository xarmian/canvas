/**
 * Render endpoint ETag + content-versioned URL caching (TASK-70).
 * Verifies:
 * - GET emits ETag, Last-Modified, and the standard short Cache-Control.
 * - GET with valid If-None-Match returns 304 (no body).
 * - GET with `?_v=<canvas updatedAt ms>` returns immutable Cache-Control.
 * - GET with stale `?_v=` falls back to short Cache-Control.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, publish } from './helpers';

test.describe('Render: ETag + content-versioned URLs', () => {
	test('ETag + 304 + immutable cache-control on matching ?v', async ({ page }) => {
		await signupAndLogin(page);
		const canvas = await createCanvas(page);
		const { imageUrl } = await publish(page);

		// Reuse the page's request context so authenticated /api/canvas
		// fetches share session cookies. Public /c/[slug] fetches don't
		// need auth but using the same context keeps things simple.
		const ctx = page.request;

		// First GET — 200 with ETag + Last-Modified + short cache-control.
		const first = await ctx.get(imageUrl);
		expect(first.status()).toBe(200);
		const etag = first.headers()['etag'];
		const lastModified = first.headers()['last-modified'];
		expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
		expect(lastModified).toBeTruthy();
		expect(first.headers()['cache-control']).toBe('public, max-age=60, s-maxage=300');
		expect(first.headers()['vary']).toContain('Accept');

		// Conditional GET with If-None-Match → 304, no body.
		const second = await ctx.get(imageUrl, { headers: { 'If-None-Match': etag } });
		expect(second.status()).toBe(304);
		expect(second.headers()['etag']).toBe(etag);
		// 304 responses must not include a body — Playwright surfaces this
		// as an empty buffer.
		expect((await second.body()).length).toBe(0);

		// Last-Modified-only conditional → also 304.
		const third = await ctx.get(imageUrl, { headers: { 'If-Modified-Since': lastModified } });
		expect(third.status()).toBe(304);

		// Re-fetch the canvas via the authenticated API to get the exact
		// updatedAt at ms precision — Last-Modified is HTTP-date and
		// loses sub-second precision, which would make a probe-by-offset
		// loop flaky.
		const apiRes = await ctx.get(`/api/canvas/${canvas.id}`);
		expect(apiRes.status()).toBe(200);
		const { updatedAt } = (await apiRes.json()) as { updatedAt: string };
		const updatedAtMs = new Date(updatedAt).getTime().toString();

		// Stale `v` falls back to short cache-control.
		const stale = await ctx.get(imageUrl + (imageUrl.includes('?') ? '&' : '?') + '_v=999');
		expect(stale.status()).toBe(200);
		expect(stale.headers()['cache-control']).toBe('public, max-age=60, s-maxage=300');

		// Matching `v` flips to immutable.
		const immutable = await ctx.get(
			imageUrl + (imageUrl.includes('?') ? '&' : '?') + `_v=${updatedAtMs}`
		);
		expect(immutable.status()).toBe(200);
		expect(immutable.headers()['cache-control']).toContain('immutable');
		expect(immutable.headers()['cache-control']).toContain('max-age=31536000');
	});
});
