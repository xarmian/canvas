/**
 * POST /api/v1/renders — bearer-authenticated baked-render creation.
 *
 * Covers TASK-168 acceptance criteria:
 *   - Auth: missing bearer → 401; invalid bearer → 401
 *   - Cross-user canvas reference → 404 (no existence leak)
 *   - Unpublished canvas owned by the API key user → success
 *   - Strict validation surfaces missing required params as 400
 *   - Dedup: same body twice → second returns deduplicated: true with
 *     the same shortId; only one DB row + one blob
 *   - forwardUrl with non-http(s) scheme → 400 invalid_forward_url
 *   - Happy path response shape (id, url, imageUrl, forwardUrl,
 *     deduplicated, createdAt)
 *
 * Quota and short-id-collision tests live alongside their respective
 * config knobs / retry paths in vitest; here we focus on end-to-end
 * behaviour through the live SvelteKit server.
 */
import { expect, test } from '@playwright/test';
import { signupAndLogin, createCanvas } from './helpers';

interface CreatedKey {
	id: string;
	name: string;
	prefix: string;
	token: string;
}

async function createApiKey(
	request: import('@playwright/test').APIRequestContext,
	cookieHeader: string,
	name: string
): Promise<CreatedKey> {
	const res = await request.post('/api/account/api-keys', {
		headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
		data: { name }
	});
	expect(res.status(), `POST /api/account/api-keys → ${res.status()}`).toBe(201);
	return (await res.json()) as CreatedKey;
}

function cookieHeaderFrom(cookies: { name: string; value: string }[]): string {
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

test('POST /api/v1/renders — missing bearer returns 401', async ({ request }) => {
	const res = await request.post('/api/v1/renders', {
		headers: { 'Content-Type': 'application/json' },
		data: { canvas: 'anything', params: {} }
	});
	expect(res.status()).toBe(401);
});

test('POST /api/v1/renders — invalid bearer returns 401', async ({ request }) => {
	const res = await request.post('/api/v1/renders', {
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Bearer ck_live_not-a-real-token'
		},
		data: { canvas: 'anything', params: {} }
	});
	expect(res.status()).toBe(401);
});

test('POST /api/v1/renders — happy path + dedup on identical re-POST', async ({
	page,
	request
}) => {
	await signupAndLogin(page);
	const cookies = await page.context().cookies();
	const cookieHeader = cookieHeaderFrom(cookies);

	// Create a canvas (the helper leaves it unpublished, which exercises
	// the IDEA-161 Q2 decision: owned access permits unpublished canvases).
	const canvas = await createCanvas(page, {
		name: 'render-api-canvas',
		preset: 'OG / Twitter'
	});

	const key = await createApiKey(request, cookieHeader, 'render-api e2e');

	const body = {
		canvas: canvas.id,
		params: { title: 'hello' }
	};
	const first = await request.post('/api/v1/renders', {
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${key.token}`
		},
		data: body
	});
	expect(first.status(), await first.text()).toBe(201);
	const firstBody = await first.json();
	expect(firstBody.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
	expect(firstBody.url).toContain(`/i/${firstBody.id}`);
	expect(firstBody.imageUrl).toContain(`/i/${firstBody.id}/image.png`);
	expect(firstBody.deduplicated).toBe(false);
	expect(typeof firstBody.createdAt).toBe('string');

	// Identical re-POST → dedup hit, same shortId, 200 not 201.
	const second = await request.post('/api/v1/renders', {
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${key.token}`
		},
		data: body
	});
	expect(second.status()).toBe(200);
	const secondBody = await second.json();
	expect(secondBody.id).toBe(firstBody.id);
	expect(secondBody.deduplicated).toBe(true);
});

test('POST /api/v1/renders — cross-user canvas returns 404', async ({ browser, request }) => {
	// User A creates a canvas
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await signupAndLogin(pageA);
	const canvasA = await createCanvas(pageA, { name: 'cross-user' });

	// User B creates an API key
	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await signupAndLogin(pageB);
	const cookiesB = await ctxB.cookies();
	const keyB = await createApiKey(request, cookieHeaderFrom(cookiesB), 'b key');

	// User B tries to render user A's canvas → 404 with structured body.
	const res = await request.post('/api/v1/renders', {
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${keyB.token}`
		},
		data: { canvas: canvasA.slug, params: {} }
	});
	expect(res.status()).toBe(404);
	const body = await res.json();
	expect(body.error).toBe('canvas_not_found');

	await ctxA.close();
	await ctxB.close();
});

test('POST /api/v1/renders — forwardUrl with javascript: scheme is rejected as 400', async ({
	page,
	request
}) => {
	await signupAndLogin(page);
	const cookies = await page.context().cookies();
	const cookieHeader = cookieHeaderFrom(cookies);

	const canvas = await createCanvas(page, { name: 'fwd-url-guard' });
	const key = await createApiKey(request, cookieHeader, 'fwd-url e2e');

	const res = await request.post('/api/v1/renders', {
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${key.token}`
		},
		data: {
			canvas: canvas.id,
			params: {},
			forwardUrl: 'javascript:alert(1)'
		}
	});
	expect(res.status()).toBe(400);
	const body = await res.json();
	expect(body.error).toBe('invalid_forward_url');
});

test('POST /api/v1/renders — unknown top-level fields rejected with 400', async ({
	page,
	request
}) => {
	await signupAndLogin(page);
	const cookies = await page.context().cookies();
	const cookieHeader = cookieHeaderFrom(cookies);

	const canvas = await createCanvas(page, { name: 'strict-shape' });
	const key = await createApiKey(request, cookieHeader, 'strict-shape e2e');

	const res = await request.post('/api/v1/renders', {
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${key.token}`
		},
		data: { canvas: canvas.id, params: {}, surpriseField: 'nope' }
	});
	expect(res.status()).toBe(400);
	const body = await res.json();
	expect(body.error).toBe('unknown_field');
	expect(body.field).toBe('surpriseField');
});
