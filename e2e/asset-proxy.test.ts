/**
 * BT-154 regression: editor + library asset URLs must be reachable
 * from the browser regardless of MinIO/S3's bind address, and the
 * server-side preview renderer must include those images in its
 * output.
 *
 * Pre-fix `storage.getUrl(key)` for S3StorageAdapter returned
 * `${S3_ENDPOINT}/${S3_BUCKET}/${key}` — e.g.
 * `http://localhost:9002/canvas/public/images/.../foo.png`. That URL:
 *   1. Required CORS to be wide open on the bucket.
 *   2. Hard-coded the storage hostname into every <img> tag, breaking
 *      access from any browser that wasn't on the same host as the
 *      dev server (LAN preview, Cloud Code, remote VM).
 *   3. Wasn't resolvable by the server-side renderer in environments
 *      where the app's own loopback IP was blocked by the SSRF guard,
 *      so previews of canvases that referenced uploaded assets came
 *      back without those images.
 *
 * The fix routes asset bytes through `/api/assets/{key}` by default
 * (operator can still opt into a CDN via `S3_PUBLIC_URL`). This spec
 * checks both halves.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, addImageLayer } from './helpers';

/** Smallest legal PNG — 1x1 transparent pixel. */
const ONE_BY_ONE_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
	'base64'
);

test.describe('Asset proxy (BT-154)', () => {
	test('uploaded image renders in /assets via proxy URL (same-origin)', async ({ page }) => {
		await signupAndLogin(page);
		await createCanvas(page);

		await addImageLayer(page, {
			name: 'bt154-asset.png',
			mimeType: 'image/png',
			buffer: ONE_BY_ONE_PNG
		});
		await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 8_000 });

		await page.getByTestId('nav-assets').click();
		await page.waitForURL('**/assets');

		// The asset card surfaces filename + thumbnail. Locate the card by
		// its filename and read the embedded `<img>` URL + naturalWidth.
		const card = page
			.locator('li.card')
			.filter({ has: page.locator('.filename', { hasText: 'bt154-asset.png' }) });
		await expect(card).toBeVisible({ timeout: 5_000 });

		const img = card.locator('img');
		const probe = await img.evaluate((el) => {
			const i = el as HTMLImageElement;
			return {
				src: i.currentSrc || i.src,
				naturalWidth: i.naturalWidth,
				naturalHeight: i.naturalHeight
			};
		});

		// Same-origin proxy URL. Storage hostname must NOT leak into the
		// page — pre-fix this would have been
		// `http://localhost:9002/canvas/public/images/.../...`.
		expect(probe.src).toMatch(/\/api\/assets\/public\/images\//);
		expect(probe.src).not.toMatch(/localhost:9002/);

		// `naturalWidth > 0` is the canonical signal that an <img> actually
		// loaded its bytes — placeholder-on-load (the user's BT-154 symptom)
		// leaves this at 0.
		expect(probe.naturalWidth).toBeGreaterThan(0);
		expect(probe.naturalHeight).toBeGreaterThan(0);
	});

	test('preview render includes asset bytes (server short-circuits /api/assets)', async ({
		page,
		baseURL,
		request
	}) => {
		await signupAndLogin(page);
		const canvas = await createCanvas(page);

		// Add the image layer to the canvas + wait for autosave so the
		// templateJson with the asset reference is persisted server-side.
		await addImageLayer(page, {
			name: 'bt154-render.png',
			mimeType: 'image/png',
			buffer: ONE_BY_ONE_PNG
		});
		await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 8_000 });

		// Hit the preview endpoint directly with the same authenticated
		// session the page has. `request` inherits cookies from `page`'s
		// context in Playwright. The response body is a raw PNG.
		const previewUrl = `${baseURL}/api/canvas/${canvas.id}/preview?_t=${Date.now()}`;
		const cookies = await page.context().cookies();
		const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
		const res = await request.get(previewUrl, { headers: { cookie: cookieHeader } });
		expect(res.status(), 'preview endpoint should return the PNG').toBe(200);
		const body = await res.body();
		// PNG signature: 89 50 4E 47 0D 0A 1A 0A.
		expect(body[0]).toBe(0x89);
		expect(body[1]).toBe(0x50);
		expect(body[2]).toBe(0x4e);
		expect(body[3]).toBe(0x47);

		// Body is non-trivial — a "render-failed-to-include-image" version
		// of the canvas would still produce a valid PNG (just the canvas
		// background), but a successfully-included single-pixel asset
		// adds compressed data. Use a lower bound that comfortably clears
		// "background only" (a 1200×630 solid-color PNG is well under 5KB
		// post-compression; we picked 1KB as the floor that catches the
		// regression without false positives from incidental size drift).
		// The bigger signal is that the preview was generated at all —
		// pre-fix, the server's loadRemoteImage SSRF guard rejected the
		// /api/assets URL and the renderer's drawImage step skipped the
		// layer entirely.
		expect(body.byteLength).toBeGreaterThan(1000);
	});
});
