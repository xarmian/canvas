/**
 * GET /api/v1/renders (list) + GET / DELETE /api/v1/renders/{shortId}
 *
 * Covers TASK-169 acceptance: pagination shape, cursor handling, cross-
 * user isolation, soft-delete behavior, and scope-enforcement (a
 * `render:read`-only key would 403 on DELETE — left to a follow-up
 * task once the scope picker exists; for now every key has all three
 * default scopes so the wiring is exercised end-to-end via the happy
 * path tests below).
 *
 * `limit=200` rejection and structured 400 shapes live in the route
 * unit-test coverage (vitest is the cheaper surface for body validation
 * — these specs focus on the integration paths through the live server).
 */
import { expect, test } from '@playwright/test';
import { signupAndLogin, createCanvas } from './helpers';

async function createApiKey(
	request: import('@playwright/test').APIRequestContext,
	cookieHeader: string
): Promise<string> {
	const res = await request.post('/api/account/api-keys', {
		headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
		data: { name: `read-side e2e ${Date.now()}` }
	});
	expect(res.status()).toBe(201);
	return (await res.json()).token as string;
}

function cookieHeader(cookies: { name: string; value: string }[]): string {
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

test('GET /api/v1/renders — list, detail, delete happy path', async ({ page, request }) => {
	await signupAndLogin(page);
	const cookies = await page.context().cookies();
	const ck = cookieHeader(cookies);
	const canvas = await createCanvas(page, { name: 'read-side' });
	const token = await createApiKey(request, ck);

	// Create two renders so the list has more than one element.
	for (const v of ['a', 'b']) {
		const create = await request.post('/api/v1/renders', {
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`
			},
			data: { canvas: canvas.id, params: { title: v } }
		});
		expect(create.status(), await create.text()).toBe(201);
	}

	// List — paginated shape.
	const listRes = await request.get('/api/v1/renders?limit=10', {
		headers: { Authorization: `Bearer ${token}` }
	});
	expect(listRes.status()).toBe(200);
	const list = await listRes.json();
	expect(Array.isArray(list.items)).toBe(true);
	expect(list.items.length).toBe(2);
	expect(list.nextCursor).toBe(null);
	for (const item of list.items) {
		expect(item.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
		expect(item.canvasSlug).toBeTruthy();
		expect(item.canvasName).toBe('read-side');
		expect(item.url).toContain(`/i/${item.id}`);
		expect(item.imageUrl).toContain(`/i/${item.id}/image.`);
	}

	// Detail
	const detailRes = await request.get(`/api/v1/renders/${list.items[0].id}`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	expect(detailRes.status()).toBe(200);
	const detail = await detailRes.json();
	expect(detail.id).toBe(list.items[0].id);

	// Delete
	const delRes = await request.delete(`/api/v1/renders/${list.items[0].id}`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	expect(delRes.status()).toBe(204);

	// Detail of deleted row → 404 (no information leak via differing
	// 404 messages).
	const after = await request.get(`/api/v1/renders/${list.items[0].id}`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	expect(after.status()).toBe(404);

	// Re-DELETE → also 404
	const reDel = await request.delete(`/api/v1/renders/${list.items[0].id}`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	expect(reDel.status()).toBe(404);

	// List no longer includes the deleted row.
	const after2 = await request.get('/api/v1/renders?limit=10', {
		headers: { Authorization: `Bearer ${token}` }
	});
	const list2 = await after2.json();
	expect(list2.items.length).toBe(1);
});

test('GET /api/v1/renders — cross-user list isolation', async ({ browser, request }) => {
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await signupAndLogin(pageA);
	const ckA = cookieHeader(await ctxA.cookies());
	const canvasA = await createCanvas(pageA, { name: 'A-canvas' });
	const tokenA = await createApiKey(request, ckA);
	await request.post('/api/v1/renders', {
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
		data: { canvas: canvasA.id, params: { title: 'A' } }
	});

	const ctxB = await browser.newContext();
	const pageB = await ctxB.newPage();
	await signupAndLogin(pageB);
	const ckB = cookieHeader(await ctxB.cookies());
	const tokenB = await createApiKey(request, ckB);

	const listB = await request.get('/api/v1/renders?limit=10', {
		headers: { Authorization: `Bearer ${tokenB}` }
	});
	expect(listB.status()).toBe(200);
	const body = await listB.json();
	expect(body.items).toEqual([]);

	await ctxA.close();
	await ctxB.close();
});

test('GET /api/v1/renders — invalid limit + invalid cursor return structured 400', async ({
	page,
	request
}) => {
	await signupAndLogin(page);
	const cookies = await page.context().cookies();
	const ck = cookieHeader(cookies);
	const token = await createApiKey(request, ck);

	const overLimit = await request.get('/api/v1/renders?limit=999', {
		headers: { Authorization: `Bearer ${token}` }
	});
	expect(overLimit.status()).toBe(400);
	expect((await overLimit.json()).error).toBe('invalid_limit');

	const badCursor = await request.get('/api/v1/renders?cursor=not-base64-json', {
		headers: { Authorization: `Bearer ${token}` }
	});
	expect(badCursor.status()).toBe(400);
	expect((await badCursor.json()).error).toBe('invalid_cursor');
});
