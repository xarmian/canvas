/**
 * Optimistic-concurrency PATCH /api/canvas/:id (TASK-98 round 6 fix).
 *
 * Closes the server-side ordering race for slug renames: when two
 * PATCHes arrive at the server concurrently, we can't control the
 * arrival order, but we CAN make the loser observable. The server
 * compares `If-Match: "<updatedAt-ms>"` to the canvas's current
 * version; mismatch returns 412.
 *
 * AbortController in PublishModal eliminates the race in the common
 * case (newer commit cancels the older one client-side). If-Match
 * is the safety net for the case where the older request had
 * already been committed by the server before the abort fired —
 * the second PATCH then sees the new version and 412s, the client
 * refetches and retries.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin } from './helpers';

test('PATCH with stale If-Match returns 412 with currentVersion', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await (
		await request.post('/api/canvas', { data: { name: `Conc ${Date.now()}` } })
	).json();

	const initial = await request.get(`/api/canvas/${canvas.id}`);
	const initialEtag = initial.headers()['etag'];
	expect(initialEtag).toBeDefined();

	// First PATCH succeeds — emits a fresh ETag.
	const first = await request.patch(`/api/canvas/${canvas.id}`, {
		headers: { 'If-Match': initialEtag, 'Content-Type': 'application/json' },
		data: { name: 'first-rename' }
	});
	expect(first.status()).toBe(200);
	const firstEtag = first.headers()['etag'];
	expect(firstEtag).toBeDefined();
	expect(firstEtag).not.toBe(initialEtag);

	// Second PATCH with the STALE If-Match must 412.
	const second = await request.patch(`/api/canvas/${canvas.id}`, {
		headers: { 'If-Match': initialEtag, 'Content-Type': 'application/json' },
		data: { name: 'second-rename' }
	});
	expect(second.status()).toBe(412);
	const body = (await second.json()) as { error: string; currentVersion: string };
	expect(body.error).toBe('precondition_failed');
	expect(body.currentVersion.length).toBeGreaterThan(0);

	// Re-PATCHing with the fresh ETag succeeds.
	const third = await request.patch(`/api/canvas/${canvas.id}`, {
		headers: { 'If-Match': firstEtag, 'Content-Type': 'application/json' },
		data: { name: 'third-rename' }
	});
	expect(third.status()).toBe(200);
});

test('PATCH without If-Match still works (last-write-wins for non-critical fields)', async ({
	page
}) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await (
		await request.post('/api/canvas', { data: { name: `NoMatch ${Date.now()}` } })
	).json();

	// Two back-to-back PATCHes without If-Match — both succeed. This
	// is the legacy contract that field-by-field auto-saves rely on.
	const a = await request.patch(`/api/canvas/${canvas.id}`, { data: { ogTitle: 'A' } });
	expect(a.status()).toBe(200);
	const b = await request.patch(`/api/canvas/${canvas.id}`, { data: { ogTitle: 'B' } });
	expect(b.status()).toBe(200);
});

test('PATCH accepts If-Match: * (any version)', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await (
		await request.post('/api/canvas', { data: { name: `Star ${Date.now()}` } })
	).json();

	const res = await request.patch(`/api/canvas/${canvas.id}`, {
		headers: { 'If-Match': '*', 'Content-Type': 'application/json' },
		data: { name: 'starred' }
	});
	expect(res.status()).toBe(200);
});

test('GET /api/canvas/:id emits ETag header', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await (
		await request.post('/api/canvas', { data: { name: `Etag ${Date.now()}` } })
	).json();

	const res = await request.get(`/api/canvas/${canvas.id}`);
	expect(res.status()).toBe(200);
	const etag = res.headers()['etag'];
	expect(etag).toBeDefined();
	// Quoted-digits format (RFC 9110 strong validator).
	expect(etag).toMatch(/^"\d+"$/);
});
