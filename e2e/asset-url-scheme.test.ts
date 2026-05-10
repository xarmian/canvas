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
	const canvas = await createCanvas(page, { name: 'Asset URL', preset: 'OG Image' });

	// Upload the same PNG twice and grab back the resolved public URL +
	// asset id. We will render both:
	//   - control: src = absolute public URL
	//   - asset:  src = asset://{id}
	// If the resolver works, both renders are byte-identical (same image
	// bytes, same dimensions). If the resolver is a no-op, asset:// is
	// unfetchable and the asset render shows a gray placeholder — bytes
	// would diverge.
	const asset = await uploadPng(request, 'logo.png');

	// Render with absolute URL as control.
	await patchSingleImageCanvas(request, canvas.id, asset.url);
	const control = await request.get(`/api/canvas/${canvas.id}/preview`);
	expect(control.status()).toBe(200);
	const controlBody = await control.body();
	expect(controlBody.length).toBeGreaterThan(100);

	// Render with asset:// scheme — should resolve to the same image and
	// produce the same bytes.
	await patchSingleImageCanvas(request, canvas.id, `asset://${asset.id}`);
	const resolved = await request.get(`/api/canvas/${canvas.id}/preview`);
	expect(resolved.status()).toBe(200);
	const resolvedBody = await resolved.body();
	expect(resolvedBody.length).toBeGreaterThan(100);
	expect(resolvedBody.equals(controlBody)).toBe(true);
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
	const canvasB = await createCanvas(pageB, { name: 'B canvas', preset: 'OG Image' });

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
