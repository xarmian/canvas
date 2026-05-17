import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * Soft-revoke a user's API key. Session-only — see the parent /server.ts
 * for why bearer tokens cannot manage their own siblings.
 *
 * Idempotency: re-revoking an already-revoked key returns 204 without
 * updating `revokedAt` (the existing timestamp is preserved so the UI
 * can show "Revoked 3 days ago" rather than "Revoked just now" after
 * an accidental double-click).
 */
// Postgres uuid columns reject non-uuid input with a SQLSTATE 22P02 that
// would bubble up as a 500. Validate the path param first so a typo'd
// URL surfaces as a clean 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!UUID_RE.test(params.id)) error(404, 'API key not found');

	const [existing] = await db
		.select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
		.from(apiKeys)
		.where(and(eq(apiKeys.id, params.id), eq(apiKeys.userId, locals.user.id)))
		.limit(1);
	if (!existing) error(404, 'API key not found');

	if (existing.revokedAt === null) {
		await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, existing.id));
	}

	return new Response(null, { status: 204 });
};
