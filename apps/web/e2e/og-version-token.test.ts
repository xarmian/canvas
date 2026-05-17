/**
 * OG image `_v` content-version token (TASK-93).
 *
 * Asserts that the og:image URL emitted at /c/{slug} contains a
 * `_v=<token>` parameter, and that the token:
 *   - changes when the canvas template is edited (template_json patch),
 *   - changes when the canvas params schema is edited (params patch),
 *   - is stable across repeated visits between edits (deterministic).
 *
 * The contract is what social caches need to auto-invalidate after a
 * canvas edit (Twitter / Bluesky / Discord all key on URL).
 */
import { test, expect } from '@playwright/test';

/** Extract the `_v` query parameter from a `<meta property="og:image">`
 *  tag in an HTML document. Returns null when missing — useful for the
 *  negative-shape assertions below. */
function extractOgImageV(html: string): string | null {
	const match = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
	if (!match) return null;
	const url = new URL(match[1]);
	return url.searchParams.get('_v');
}

async function createSession(
	request: import('@playwright/test').APIRequestContext,
	tag: string
): Promise<{ cookies: string; canvas: { id: string; slug: string } }> {
	const signup = await request.post('/api/auth/sign-up/email', {
		data: { name: 'V Tester', email: `v-${tag}-${Date.now()}@test.com`, password: 'testpass123456' }
	});
	const cookies = signup.headers()['set-cookie'] || '';
	const create = await request.post('/api/canvas', {
		data: { name: `V ${tag} ${Date.now()}`, width: 1200, height: 630 },
		headers: { cookie: cookies }
	});
	const canvas = await create.json();
	await request.patch(`/api/canvas/${canvas.id}`, {
		data: { published: true },
		headers: { cookie: cookies }
	});
	return { cookies, canvas };
}

test('og:image URL embeds a _v token', async ({ request }) => {
	const { canvas } = await createSession(request, 'embed');

	const res = await request.get(`/c/${canvas.slug}`, {
		headers: { 'user-agent': 'Twitterbot/1.0' }
	});
	expect(res.status()).toBe(200);

	const v = extractOgImageV(await res.text());
	expect(v).not.toBeNull();
	expect(v).toMatch(/^[a-f0-9]{12}$/); // SHA-256 prefix, 12 hex chars
});

test('_v changes after a templateJson edit', async ({ request }) => {
	const { cookies, canvas } = await createSession(request, 'tpl');

	const before = extractOgImageV(
		await (
			await request.get(`/c/${canvas.slug}`, { headers: { 'user-agent': 'Twitterbot/1.0' } })
		).text()
	);
	expect(before).not.toBeNull();

	// Wait 5ms so the updatedAt clock advances (ISO ms resolution
	// guarantees a different millisecond after the patch).
	await new Promise((r) => setTimeout(r, 5));
	await request.patch(`/api/canvas/${canvas.id}`, {
		data: { templateJson: { version: '1.0', objects: [{ type: 'text', text: 'edited' }] } },
		headers: { cookie: cookies }
	});

	const after = extractOgImageV(
		await (
			await request.get(`/c/${canvas.slug}`, { headers: { 'user-agent': 'Twitterbot/1.0' } })
		).text()
	);
	expect(after).not.toBeNull();
	expect(after).not.toBe(before); // template edit must invalidate cards
});

test('_v changes after a params-schema edit', async ({ request }) => {
	const { cookies, canvas } = await createSession(request, 'schema');

	const before = extractOgImageV(
		await (
			await request.get(`/c/${canvas.slug}`, { headers: { 'user-agent': 'Twitterbot/1.0' } })
		).text()
	);
	expect(before).not.toBeNull();

	await new Promise((r) => setTimeout(r, 5));
	// Param-only PATCH must still bump updatedAt (existing behavior in
	// `api/canvas/[id]/+server.ts`) so the `_v` token rolls.
	await request.patch(`/api/canvas/${canvas.id}`, {
		data: { params: [{ name: 'title', required: true }] },
		headers: { cookie: cookies }
	});

	const after = extractOgImageV(
		await (
			await request.get(`/c/${canvas.slug}`, { headers: { 'user-agent': 'Twitterbot/1.0' } })
		).text()
	);
	expect(after).not.toBeNull();
	expect(after).not.toBe(before);
});

test('_v is deterministic across repeat visits between edits', async ({ request }) => {
	const { canvas } = await createSession(request, 'stable');

	const visits = await Promise.all(
		Array.from({ length: 4 }, () =>
			request.get(`/c/${canvas.slug}`, { headers: { 'user-agent': 'Twitterbot/1.0' } })
		)
	);
	const tokens = await Promise.all(visits.map(async (r) => extractOgImageV(await r.text())));
	expect(new Set(tokens).size).toBe(1); // all 4 must be identical
});

test('og:image _v matches the immutable-cache opt-in token on the render route', async ({
	request
}) => {
	// Closes the contract: the share-page _v IS the same token the render
	// route accepts as immutable-cache hint. If they ever drift, embed-code
	// snippets would silently lose immutable caching.
	const { canvas } = await createSession(request, 'match');

	const ogToken = extractOgImageV(
		await (
			await request.get(`/c/${canvas.slug}`, { headers: { 'user-agent': 'Twitterbot/1.0' } })
		).text()
	);
	expect(ogToken).not.toBeNull();

	// Hitting the render URL with that exact `_v` should succeed and
	// flip Cache-Control to immutable. Use a unique XFF so the per-IP
	// rate limit doesn't collide with neighboring tests.
	const renderRes = await request.get(`/c/${canvas.slug}/image.png?_v=${ogToken}`, {
		headers: {
			'X-Forwarded-For': `10.${Math.floor(Math.random() * 256)}.${Math.floor(
				Math.random() * 256
			)}.${Math.floor(Math.random() * 256)}`
		}
	});
	expect(renderRes.status()).toBe(200);
	expect(renderRes.headers()['cache-control']).toContain('immutable');
});
