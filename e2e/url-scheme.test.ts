/**
 * URL scheme contract tests (TASK-92).
 *
 * Asserts the v1 slug behavior against the live HTTP API:
 *   - POST /api/canvas auto-derives a slug from `name` with no nanoid suffix.
 *   - Two canvases with the same name resolve via `-2`, `-3`, ... suffixes.
 *   - PATCH /api/canvas/:id accepts a user-chosen `slug`.
 *   - PATCH on an already-taken slug returns 409 with a suggestion.
 *   - PATCH with an invalid slug format returns 400.
 *   - POST /api/canvas/:id/duplicate produces a slug with no nanoid noise.
 *
 * Tests sign up a fresh user per test and use `page.request` so the
 * SvelteKit handlers see them as authenticated callers — same pattern
 * as the publish-and-share flow. Canvas names embed a unique token so
 * tests don't collide with each other or with leftover rows from
 * previous runs against the same TEST_DATABASE_URL.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin } from './helpers';

/** Unique-per-test base used both as the canvas display name and as the
 *  expected slug seed. Lowercased + hyphenated for the slug; the original
 *  for the API name field. */
function uniqueBase(prefix: string): { name: string; slug: string } {
	const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const name = `${prefix} ${tag}`;
	const slug = `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${tag}`;
	return { name, slug };
}

test('POST /api/canvas auto-derives slug without nanoid suffix', async ({ page }) => {
	await signupAndLogin(page);
	const { name, slug: expected } = uniqueBase('Hello');

	const res = await page.request.post('/api/canvas', {
		data: { name, width: 1200, height: 630 }
	});
	expect(res.status()).toBe(201);
	const created = await res.json();
	// New scheme: slug is the lowercased, hyphenated name. Old scheme
	// would have appended `-{nanoid(8)}` (e.g. `hello-...-aB3xY9_q`).
	expect(created.slug).toBe(expected);
	// And explicitly: no eight-char base-62 nanoid suffix on the end.
	expect(created.slug).not.toMatch(/-[A-Za-z0-9_-]{8}$/);
});

test('POST /api/canvas resolves slug collision with smallest -N suffix', async ({ page }) => {
	await signupAndLogin(page);
	const { name, slug: expected } = uniqueBase('Collide');

	const first = await page.request.post('/api/canvas', { data: { name } });
	expect(first.status()).toBe(201);
	expect((await first.json()).slug).toBe(expected);

	const second = await page.request.post('/api/canvas', { data: { name } });
	expect(second.status()).toBe(201);
	expect((await second.json()).slug).toBe(`${expected}-2`);

	const third = await page.request.post('/api/canvas', { data: { name } });
	expect(third.status()).toBe(201);
	expect((await third.json()).slug).toBe(`${expected}-3`);
});

test('PATCH /api/canvas/:id accepts a user-chosen slug', async ({ page }) => {
	await signupAndLogin(page);
	const { name } = uniqueBase('Rename Me');
	const created = await (await page.request.post('/api/canvas', { data: { name } })).json();
	const target = `final-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

	const patched = await page.request.patch(`/api/canvas/${created.id}`, {
		data: { slug: target }
	});
	expect(patched.status()).toBe(200);
	expect((await patched.json()).slug).toBe(target);
});

test('PATCH /api/canvas/:id returns 409 with suggestion on slug collision', async ({ page }) => {
	await signupAndLogin(page);
	const { name, slug: existingSlug } = uniqueBase('Existing');
	await page.request.post('/api/canvas', { data: { name } });

	const targetCanvas = await (
		await page.request.post('/api/canvas', { data: { name: `${name} Other` } })
	).json();

	const conflict = await page.request.patch(`/api/canvas/${targetCanvas.id}`, {
		data: { slug: existingSlug }
	});
	expect(conflict.status()).toBe(409);
	const body = await conflict.json();
	expect(body.error).toBe('slug_taken');
	expect(body.suggestion).toBe(`${existingSlug}-2`);
});

test('PATCH /api/canvas/:id returns 400 on invalid slug format', async ({ page }) => {
	await signupAndLogin(page);
	const { name } = uniqueBase('Validate');
	const target = await (await page.request.post('/api/canvas', { data: { name } })).json();

	for (const bad of ['Has Spaces', 'UPPER', '-leading', 'trailing-', 'doub--le', '']) {
		const res = await page.request.patch(`/api/canvas/${target.id}`, { data: { slug: bad } });
		expect(res.status(), `slug "${bad}" should be rejected`).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_slug');
	}
});

test('PATCH /api/canvas/:id rejects reserved slugs', async ({ page }) => {
	await signupAndLogin(page);
	const { name } = uniqueBase('Reserved Test');
	const target = await (await page.request.post('/api/canvas', { data: { name } })).json();

	const res = await page.request.patch(`/api/canvas/${target.id}`, { data: { slug: 'api' } });
	expect(res.status()).toBe(400);
	expect((await res.json()).error).toBe('invalid_slug');
});

test('PATCH /api/canvas/:id no-op rename to current slug succeeds', async ({ page }) => {
	await signupAndLogin(page);
	const { name } = uniqueBase('Idempotent');
	const created = await (await page.request.post('/api/canvas', { data: { name } })).json();

	const res = await page.request.patch(`/api/canvas/${created.id}`, {
		data: { slug: created.slug }
	});
	expect(res.status()).toBe(200);
	expect((await res.json()).slug).toBe(created.slug);
});

test('POST /api/canvas concurrent same-name creates resolve to distinct slugs (no 500s)', async ({
	page
}) => {
	await signupAndLogin(page);
	const { name, slug: expected } = uniqueBase('Race');

	// Fire 12 concurrent POSTs with the same name. The TOCTOU window
	// between the slug probe and the INSERT means losers can converge
	// on the same `-N` candidate; the unique index would 500 a loser
	// without `insertWithUniqueSlug`'s retry+jitter loop. Codex round 2
	// flagged a 5-only retry budget — this test guards against the
	// regression by burst-creating well above the original cap.
	const responses = await Promise.all(
		Array.from({ length: 12 }, () => page.request.post('/api/canvas', { data: { name } }))
	);
	expect(responses.every((r) => r.status() === 201)).toBe(true);

	const slugs = await Promise.all(responses.map(async (r) => (await r.json()).slug as string));
	const unique = new Set(slugs);
	expect(unique.size).toBe(slugs.length); // every winner got a distinct slug
	for (const slug of slugs) {
		expect(slug === expected || slug.startsWith(`${expected}-`)).toBe(true);
	}
});

test('POST /api/canvas/:id/duplicate produces a slug with no nanoid suffix', async ({ page }) => {
	await signupAndLogin(page);
	const { name, slug: baseSlug } = uniqueBase('Source');
	const source = await (await page.request.post('/api/canvas', { data: { name } })).json();
	expect(source.slug).toBe(baseSlug);

	const dup = await page.request.post(`/api/canvas/${source.id}/duplicate`, { data: {} });
	expect(dup.status()).toBe(201);
	const body = await dup.json();
	// "<name>" + " (copy)" → slugify → "<base>-copy".
	expect(body.slug).toBe(`${baseSlug}-copy`);
	expect(body.slug).not.toMatch(/-[A-Za-z0-9_-]{8}$/);

	// Duplicating again resolves via `-2` rather than a nanoid blob.
	const dup2 = await page.request.post(`/api/canvas/${source.id}/duplicate`, { data: {} });
	expect(dup2.status()).toBe(201);
	expect((await dup2.json()).slug).toBe(`${baseSlug}-copy-2`);
});
