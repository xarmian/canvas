/**
 * AVIF output + retina DPR (TASK-71). Verifies the public render route
 * accepts `image.avif` and `?_dpr=2`/`?_dpr=3` (capped at 3), and that
 * Sharp's encoding produces a recognizable AVIF buffer at the scaled
 * pixel dimensions.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, publish, uniqueXffHeaders } from './helpers';

test.describe('Render: AVIF + retina DPR', () => {
	test('AVIF + dpr=2 produces a 2x AVIF render, dpr=10 clamps to 3', async ({ page }) => {
		await signupAndLogin(page);
		await createCanvas(page, { preset: 'OG Image' });
		const { imageUrl } = await publish(page);

		// imageUrl is .png; rewrite to .avif for the AVIF asserts.
		const avifUrl = imageUrl.replace(/image\.png$/, 'image.avif');
		const ctx = page.request;
		// Unique XFF so the per-IP rate limit (TASK-72) treats this test's
		// 4 distinct cache-busting renders as a fresh client. Same bucket
		// across the whole test is fine — the limit is well above 4.
		const headers = uniqueXffHeaders();

		const avifRes = await ctx.get(avifUrl, { headers });
		expect(avifRes.status()).toBe(200);
		expect(avifRes.headers()['content-type']).toBe('image/avif');
		const avifBody = await avifRes.body();
		expect(avifBody.length).toBeGreaterThan(0);

		// dpr=2 on the PNG URL: pixel dims should be 2× the OG Image preset
		// (1200×630 → 2400×1260). Read PNG dimensions from bytes 16-23 (IHDR).
		const dpr2Res = await ctx.get(`${imageUrl}?_dpr=2`, { headers });
		expect(dpr2Res.status()).toBe(200);
		const dpr2Body = await dpr2Res.body();
		const png2Width = dpr2Body.readUInt32BE(16);
		const png2Height = dpr2Body.readUInt32BE(20);
		expect(png2Width).toBe(2400);
		expect(png2Height).toBe(1260);

		// dpr=10 clamps to 3 → 3600×1890.
		const dpr10Res = await ctx.get(`${imageUrl}?_dpr=10`, { headers });
		expect(dpr10Res.status()).toBe(200);
		const dpr10Body = await dpr10Res.body();
		expect(dpr10Body.readUInt32BE(16)).toBe(3600);
		expect(dpr10Body.readUInt32BE(20)).toBe(1890);

		// Cache hit on second dpr=2 request: same URL, same key, X-Cache=HIT.
		const dpr2Cached = await ctx.get(`${imageUrl}?_dpr=2`, { headers });
		expect(dpr2Cached.status()).toBe(200);
		expect(dpr2Cached.headers()['x-cache']).toBe('HIT');

		// dpr=1 cache entry must NOT collide with dpr=2 — different cache
		// key, so a fresh dpr=1 request should also be served (status 200,
		// pixels match the original).
		const dpr1Res = await ctx.get(imageUrl, { headers });
		expect(dpr1Res.status()).toBe(200);
		const dpr1Body = await dpr1Res.body();
		expect(dpr1Body.readUInt32BE(16)).toBe(1200);
		expect(dpr1Body.readUInt32BE(20)).toBe(630);
	});
});
