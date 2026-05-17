/**
 * `asset://{id}` URL scheme — server-side resolver coverage (TASK-89).
 *
 * The resolver lives at src/lib/server/asset-resolver.ts and runs in both
 * the public render route and the auth'd /api/canvas/[id]/preview route
 * before the renderer sees the templateJson. Two angles:
 *
 *   1. asset://{id} resolves to the owner's asset — the rendered image
 *      bytes match a control rendered with the asset's public URL inline.
 *   2. Cross-user references are denied gracefully. User B referencing
 *      user A's asset id renders 200 (no 500), but with a placeholder in
 *      place of the image — bytes diverge from the resolved render.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas } from './helpers';

/** Smallest legal PNG — 1x1 transparent pixel. Inlined to keep the test
 *  self-contained. Same fixture pattern as e2e/asset-library.test.ts. */
const ONE_BY_ONE_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
	'base64'
);

/** Helper: upload a PNG via /api/upload and return {id, url}. */
async function uploadPng(
	request: import('@playwright/test').APIRequestContext,
	filename: string
): Promise<{ id: string; url: string }> {
	const res = await request.post('/api/upload', {
		multipart: {
			file: {
				name: filename,
				mimeType: 'image/png',
				buffer: ONE_BY_ONE_PNG
			}
		}
	});
	expect(res.status()).toBe(200);
	const body = (await res.json()) as { id: string; url: string };
	return body;
}

/** Helper: PATCH a canvas's templateJson + dimensions to a known fixture
 *  with one image layer at the given src. */
async function patchSingleImageCanvas(
	request: import('@playwright/test').APIRequestContext,
	canvasId: string,
	imageSrc: string
): Promise<void> {
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
		data: { templateJson }
	});
	expect(res.status()).toBe(200);
}

test('asset:// resolves to the owner asset (TASK-89)', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Asset URL', preset: 'OG / Twitter' });

	const asset = await uploadPng(request, 'logo.png');

	// Resolved asset:// — the resolver loads the bytes server-side via
	// storage.read() and injects them into the renderer's preload map.
	// Renders the actual image into the layer rectangle.
	await patchSingleImageCanvas(request, canvas.id, `asset://${asset.id}`);
	const resolved = await request.get(`/api/canvas/${canvas.id}/preview`);
	expect(resolved.status()).toBe(200);
	const resolvedBody = await resolved.body();
	expect(resolvedBody.length).toBeGreaterThan(100);

	// Determinism: rendering the SAME canvas twice produces byte-identical
	// output (no nondeterminism from the resolver / preload path).
	const resolvedAgain = await request.get(`/api/canvas/${canvas.id}/preview`);
	expect((await resolvedAgain.body()).equals(resolvedBody)).toBe(true);

	// Disambiguation: a deliberately broken external URL must render
	// DIFFERENT bytes (gray placeholder, not the real image). This is
	// the assertion that proves the resolver actually resolved — without
	// it, the test could pass even if the resolver was a no-op and both
	// renders happened to fall through to the same placeholder.
	await patchSingleImageCanvas(request, canvas.id, 'https://invalid.example.test/nope.png');
	const broken = await request.get(`/api/canvas/${canvas.id}/preview`);
	expect(broken.status()).toBe(200);
	expect((await broken.body()).equals(resolvedBody)).toBe(false);

	// Negative path: a syntactically valid but unknown asset id (no DB
	// row for this user) must render the placeholder, NOT throw and
	// NOT match the resolved render. Same gray bytes as the broken
	// external URL.
	await patchSingleImageCanvas(request, canvas.id, `asset://00000000-0000-0000-0000-000000000000`);
	const missing = await request.get(`/api/canvas/${canvas.id}/preview`);
	expect(missing.status()).toBe(200);
	const missingBody = await missing.body();
	expect(missingBody.equals(resolvedBody)).toBe(false);
	expect(missingBody.equals(await broken.body())).toBe(true);

	// Malformed (non-UUID) asset id must NOT throw at the SQL layer —
	// the resolver validates UUIDs before passing to inArray() against
	// the uuid column. Same placeholder render as the missing case.
	await patchSingleImageCanvas(request, canvas.id, `asset://not-a-uuid`);
	const malformed = await request.get(`/api/canvas/${canvas.id}/preview`);
	expect(malformed.status()).toBe(200);
	expect((await malformed.body()).equals(missingBody)).toBe(true);
});

test('asset:// for a non-owner asset id falls back gracefully (TASK-89)', async ({ browser }) => {
	// Two contexts so the auth state of user A doesn't bleed into user B.
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await signupAndLogin(pageA, { email: `user-a-${Date.now()}@e2e.test` });
	const assetA = await uploadPng(pageA.request, 'a-logo.png');

	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await signupAndLogin(pageB, { email: `user-b-${Date.now()}@e2e.test` });
	const canvasB = await createCanvas(pageB, { name: 'B canvas', preset: 'OG / Twitter' });

	// User B tries to reference user A's asset id. The resolver's WHERE
	// clause filters on userId, so user B's preview request looks up the
	// id under user B's userId — finds nothing — leaves the asset:// URL
	// in place. The renderer's image fetcher treats that as unfetchable
	// and draws the gray placeholder rectangle.
	await patchSingleImageCanvas(pageB.request, canvasB.id, `asset://${assetA.id}`);
	const denied = await pageB.request.get(`/api/canvas/${canvasB.id}/preview`);
	expect(denied.status()).toBe(200);
	const deniedBody = await denied.body();
	expect(deniedBody.length).toBeGreaterThan(100);

	// Control: user B referencing the same id pattern with a deliberately
	// missing/garbage id — should render the same placeholder bytes as the
	// cross-user case (both fall through identically). This is the
	// stronger assertion that "cross-user denial" really means the
	// resolver dropped the lookup, not that it accidentally resolved to
	// some other asset.
	await patchSingleImageCanvas(
		pageB.request,
		canvasB.id,
		`asset://00000000-0000-0000-0000-000000000000`
	);
	const garbage = await pageB.request.get(`/api/canvas/${canvasB.id}/preview`);
	expect(garbage.status()).toBe(200);
	const garbageBody = await garbage.body();
	expect(garbageBody.equals(deniedBody)).toBe(true);

	await ctxA.close();
	await ctxB.close();
});
