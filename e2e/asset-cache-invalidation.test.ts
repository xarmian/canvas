/**
 * Render cache invalidation on asset:// reference changes (TASK-117).
 *
 * Before TASK-117, the render cache key derived from `canvas.updatedAt`
 * + font version, neither of which moved when an asset row was
 * mutated. A user who deleted an asset and re-viewed a published
 * canvas kept getting the cached resolved render — the canvas's
 * templateJson still referenced the old `asset://` id, but the cache
 * entry contained the resolved bytes for the now-missing asset.
 *
 * The fix bakes a fingerprint of (id, storage_key) for currently-
 * referenced assets into the cache key. Deleting drops entries from
 * the fingerprint, so the next render misses the cache and renders
 * the placeholder (or the renderer's standard not-found path). No
 * canvas edit required.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, uniqueXffHeaders } from './helpers';

/** Smallest legal PNG — 1x1 transparent pixel. */
const ONE_BY_ONE_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
	'base64'
);

async function uploadPng(
	request: import('@playwright/test').APIRequestContext,
	filename: string
): Promise<{ id: string }> {
	const res = await request.post('/api/upload', {
		multipart: { file: { name: filename, mimeType: 'image/png', buffer: ONE_BY_ONE_PNG } }
	});
	expect(res.status()).toBe(200);
	return (await res.json()) as { id: string };
}

async function patchAndPublish(
	request: import('@playwright/test').APIRequestContext,
	canvasId: string,
	imageSrc: string
): Promise<{ slug: string }> {
	const templateJson = {
		version: '6.0.0',
		objects: [
			{
				type: 'image',
				left: 100,
				top: 100,
				width: 600,
				height: 400,
				src: imageSrc
			}
		]
	};
	const res = await request.patch(`/api/canvas/${canvasId}`, {
		data: { templateJson, published: true }
	});
	expect(res.status()).toBe(200);
	const body = (await res.json()) as { slug: string };
	return { slug: body.slug };
}

/** Hash a Buffer's bytes to a short hex string so test assertions can
 *  compare two renders for "same" / "different" without storing
 *  multi-KB blobs in the test code. */
async function bytesHash(buf: Buffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(digest))
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

test('deleting an asset that a published canvas references invalidates the cached render', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);

	// Canvas references an uploaded asset.
	const created = await createCanvas(page, {
		name: `Asset cache ${Date.now()}`,
		preset: 'OG Image'
	});
	const asset = await uploadPng(request, 'pic.png');
	const { slug } = await patchAndPublish(request, created.id, `asset://${asset.id}`);

	// Prime the cache: first render populates the on-disk cache entry
	// for this slug + asset fingerprint.
	const first = await request.get(`/c/${slug}/image.png`, { headers: uniqueXffHeaders() });
	expect(first.status()).toBe(200);
	const firstBytes = await first.body();
	const firstHash = await bytesHash(firstBytes);

	// Second render is a cache hit — same bytes.
	const cached = await request.get(`/c/${slug}/image.png`, { headers: uniqueXffHeaders() });
	expect(cached.status()).toBe(200);
	expect(cached.headers()['x-cache']).toBe('HIT');
	expect(await bytesHash(await cached.body())).toBe(firstHash);

	// Delete the asset. canvas.updatedAt is unchanged. Without
	// TASK-117 the cache would keep serving `firstBytes`.
	const del = await request.delete(`/api/library/${asset.id}`);
	expect(del.status()).toBe(200);

	// Next render: the asset-set fingerprint dropped the deleted id,
	// so the cache key changed → MISS → fresh render of the
	// placeholder (or the renderer's not-found path). Bytes differ
	// from the cached pre-delete render.
	const afterDelete = await request.get(`/c/${slug}/image.png`, {
		headers: uniqueXffHeaders()
	});
	expect(afterDelete.status()).toBe(200);
	expect(afterDelete.headers()['x-cache']).toBe('MISS');
	const afterHash = await bytesHash(await afterDelete.body());
	expect(afterHash).not.toBe(firstHash);
});

test('re-uploading after delete keeps the cache invalidated (canvas still references old id)', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);

	const created = await createCanvas(page, {
		name: `Asset reupload ${Date.now()}`,
		preset: 'OG Image'
	});
	const asset = await uploadPng(request, 'logo.png');
	const { slug } = await patchAndPublish(request, created.id, `asset://${asset.id}`);

	// Prime + verify HIT.
	const primed = await request.get(`/c/${slug}/image.png`, { headers: uniqueXffHeaders() });
	expect(primed.status()).toBe(200);
	const primedHash = await bytesHash(await primed.body());

	// Delete the asset.
	expect((await request.delete(`/api/library/${asset.id}`)).status()).toBe(200);

	// Re-upload (creates a new asset row with a new UUID — the canvas
	// still references the OLD id since nothing edited templateJson).
	await uploadPng(request, 'logo.png');

	// Render now: the asset-set fingerprint is empty (canvas's old
	// id no longer exists; new asset has a different id that the
	// canvas doesn't reference). Cache MISS, fresh render with
	// placeholder. Bytes differ from primed.
	const afterReupload = await request.get(`/c/${slug}/image.png`, {
		headers: uniqueXffHeaders()
	});
	expect(afterReupload.status()).toBe(200);
	expect(afterReupload.headers()['x-cache']).toBe('MISS');
	expect(await bytesHash(await afterReupload.body())).not.toBe(primedHash);
});

test('_v token rolls when a referenced asset is deleted (Codex round 1 P1)', async ({ page }) => {
	// Without folding the asset-set fingerprint into `_v`, social-CDN
	// immutable-cache opt-in URLs would still match after a delete →
	// CDNs would keep serving the pre-delete render for up to a year.
	const request = page.request;
	await signupAndLogin(page);
	const created = await createCanvas(page, {
		name: `Asset _v ${Date.now()}`,
		preset: 'OG Image'
	});
	const asset = await uploadPng(request, 'tok.png');
	const { slug } = await patchAndPublish(request, created.id, `asset://${asset.id}`);

	// Read `_v` from the share page (bot UA) before delete.
	const beforeShare = await request.get(`/c/${slug}`, {
		headers: { 'user-agent': 'Twitterbot/1.0' }
	});
	const beforeHtml = await beforeShare.text();
	const beforeV = (beforeHtml.match(/og:image"\s+content="[^"]*[?&]_v=([a-f0-9]{12})/) || [])[1];
	expect(beforeV).toBeDefined();

	// Delete the asset.
	expect((await request.delete(`/api/library/${asset.id}`)).status()).toBe(200);

	// Re-read share page. `_v` must have rolled — otherwise an
	// immutable-cached CDN entry from before would keep serving.
	const afterShare = await request.get(`/c/${slug}`, {
		headers: { 'user-agent': 'Twitterbot/1.0' }
	});
	const afterHtml = await afterShare.text();
	const afterV = (afterHtml.match(/og:image"\s+content="[^"]*[?&]_v=([a-f0-9]{12})/) || [])[1];
	expect(afterV).toBeDefined();
	expect(afterV).not.toBe(beforeV);
});

test('renders without asset:// refs are unaffected by asset library mutations', async ({
	page
}) => {
	// Sanity check: a canvas that doesn't reference any asset:// url
	// should not see its cache busted when the user uploads / deletes
	// other assets in their library. The fingerprint is empty for
	// these canvases, and changes to unrelated assets don't move it.
	const request = page.request;
	await signupAndLogin(page);

	const created = await createCanvas(page, {
		name: `No asset refs ${Date.now()}`,
		preset: 'OG Image'
	});
	// Empty templateJson — no image layers, no asset refs.
	const patchRes = await request.patch(`/api/canvas/${created.id}`, {
		data: { templateJson: { version: '6.0.0', objects: [] }, published: true }
	});
	expect(patchRes.status()).toBe(200);
	const slug = ((await patchRes.json()) as { slug: string }).slug;

	const first = await request.get(`/c/${slug}/image.png`, { headers: uniqueXffHeaders() });
	expect(first.status()).toBe(200);
	const firstHash = await bytesHash(await first.body());

	// Upload an unrelated asset, then delete one. Neither touches the
	// canvas's templateJson, and the canvas references no asset://
	// urls — so the cache key stays the same.
	const asset = await uploadPng(request, 'unused.png');
	await request.delete(`/api/library/${asset.id}`);

	const second = await request.get(`/c/${slug}/image.png`, {
		headers: uniqueXffHeaders()
	});
	expect(second.status()).toBe(200);
	// Cache hit.
	expect(second.headers()['x-cache']).toBe('HIT');
	expect(await bytesHash(await second.body())).toBe(firstHash);
});
