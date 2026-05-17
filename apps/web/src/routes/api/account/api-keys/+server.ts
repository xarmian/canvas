import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq, desc, and, isNull } from 'drizzle-orm';
import { generateApiKey } from '$lib/server/api-key';

/**
 * Session-cookie-authenticated management API for /account/api-keys.
 *
 * This is the app-internal surface (separate from the bearer-token-only
 * `/api/v1/*`). Bearer tokens cannot manage their own siblings — that
 * would let a leaked key revoke or replace itself. The session-only
 * gate is enforced by `locals.user` (which `hooks.server.ts` only
 * populates from session cookies — see TASK-166 Codex review round 1).
 *
 * Default v1 scopes: every newly-created key receives all three render
 * scopes. A scope picker is out of scope for v1 — see TASK-167 spec.
 */
const DEFAULT_SCOPES = ['render:create', 'render:read', 'render:delete'] as const;

const MAX_NAME_LENGTH = 80;

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const showRevoked = url.searchParams.get('showRevoked') === '1';

	const where = showRevoked
		? eq(apiKeys.userId, locals.user.id)
		: and(eq(apiKeys.userId, locals.user.id), isNull(apiKeys.revokedAt));

	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			scopes: apiKeys.scopes,
			lastUsedAt: apiKeys.lastUsedAt,
			revokedAt: apiKeys.revokedAt,
			createdAt: apiKeys.createdAt
		})
		.from(apiKeys)
		.where(where)
		.orderBy(desc(apiKeys.createdAt));

	return json(rows);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const body = await request.json().catch(() => null);
	const rawName = body?.name;
	if (typeof rawName !== 'string') error(400, 'name is required');
	const name = rawName.trim();
	if (name.length === 0) error(400, 'name is required');
	if (name.length > MAX_NAME_LENGTH) {
		error(400, `name must be ${MAX_NAME_LENGTH} characters or fewer`);
	}

	// Prefix collisions are astronomically rare (4 random base64url chars
	// → ~16M space, scoped to all live keys) but the column is UNIQUE so a
	// collision would surface as a 500. Re-roll on conflict; cap at 3
	// attempts so a corrupted RNG can't loop forever.
	let attempts = 0;
	while (attempts < 3) {
		attempts += 1;
		const { token, prefix, hashedSecret } = await generateApiKey();
		try {
			const [row] = await db
				.insert(apiKeys)
				.values({
					userId: locals.user.id,
					name,
					prefix,
					hashedSecret,
					scopes: [...DEFAULT_SCOPES]
				})
				.returning({
					id: apiKeys.id,
					name: apiKeys.name,
					prefix: apiKeys.prefix,
					scopes: apiKeys.scopes,
					createdAt: apiKeys.createdAt
				});

			// `token` is in the response exactly ONCE. The client surfaces it in
			// the copy-once modal and discards it on close.
			return json({ ...row, token }, { status: 201 });
		} catch (err) {
			// Re-throw anything that isn't the unique-prefix collision.
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes('api_keys_prefix_unique')) throw err;
		}
	}
	error(500, 'Could not allocate a unique key prefix; please retry');
};
