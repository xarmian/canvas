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

		// `<img loading="lazy">` may not have finished fetching the moment
		// the card becomes visible. Poll for `naturalWidth > 0` — the
		// canonical signal that the image actually loaded — instead of
		// reading once and risking a flake on slow CI (Codex round 3 P2).
		// `naturalWidth === 0` is also the placeholder-on-load state that
		// is the user-reported BT-154 symptom, so the same poll covers
		// both the regression and the flake mitigation.
		await expect
			.poll(
				async () =>
					img.evaluate((el) => {
						const i = el as HTMLImageElement;
						return i.naturalWidth > 0 && i.complete ? i.naturalWidth : null;
					}),
				{
					timeout: 5_000,
					message: 'asset library <img> failed to load bytes (BT-154 symptom)'
				}
			)
			.toBeGreaterThan(0);

		// Once we know the image loaded, snapshot the URL it actually
		// resolved to. Same-origin proxy path is the BT-154 contract —
		// storage hostname must NOT leak.
		const src = await img.evaluate(
			(el) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src
		);
		expect(src).toMatch(/\/api\/assets\/public\/images\//);
		expect(src).not.toMatch(/localhost:9002/);
	});
});

// Note: dropped a second test that hit `/api/canvas/{id}/preview` and
// asserted `body.byteLength > 1000`. A blank 1200×630 PNG already
// exceeds that threshold (~4.5KB post-compression), so the assertion
// would have passed even with the image silently skipped — false
// confidence (Codex round 2). The asset-render path is exercised
// strongly enough by the `asset-url-scheme.test.ts` / `asset-cache-
// invalidation.test.ts` specs via the published `/c/{slug}/image.*`
// route; the regression here is the URL contract that the test above
// covers directly.
