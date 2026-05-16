/**
 * DELETE /api/admin/users/[id]/api-keys/[keyId]
 *
 * Admin soft-revoke of a target user's API key (TASK-187 / PLAN-180).
 *
 * Auth is enforced server-side here — UI gating doesn't count. Matches
 * the existing `/api/account/api-keys/[id]` shape (idempotent
 * soft-revoke via setting `revokedAt`) but with two differences worth
 * being explicit about:
 *
 *  1. The key is matched on `(id, userId)` against the *path-param*
 *     user, not `locals.user`. That's the whole point of the admin
 *     surface: revoke someone else's key.
 *  2. The revoke + audit-log row land atomically in a transaction so a
 *     failed audit insert can't leave a destructive action without a
 *     trail (same pattern as TASK-186's force-delete-all-renders).
 */
import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { requireAdmin } from '$lib/server/admin';
import { recordAdminAction } from '$lib/server/admin-audit';

// Postgres uuid columns reject non-uuid input with SQLSTATE 22P02 that
// would bubble up as a 500. Validate the path param first so a typo'd
// URL surfaces as a clean 404, matching the user-facing endpoint.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user || !locals.session) error(401, 'Unauthorized');
	requireAdmin(locals.user);

	if (!UUID_RE.test(params.keyId)) error(404, 'API key not found');

	const [existing] = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			revokedAt: apiKeys.revokedAt
		})
		.from(apiKeys)
		.where(and(eq(apiKeys.id, params.keyId), eq(apiKeys.userId, params.id)))
		.limit(1);
	if (!existing) error(404, 'API key not found');

	// Idempotent: re-revoking a revoked key preserves the original
	// timestamp (so the UI keeps showing "Revoked 3 days ago" rather
	// than jumping to "just now" on an accidental double-click). We
	// also skip the audit-log entry in the no-op case — a re-revoke
	// isn't a new admin action.
	if (existing.revokedAt !== null) {
		return new Response(null, { status: 204 });
	}

	await db.transaction(async (tx) => {
		await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, existing.id));
		await recordAdminAction(
			{
				actor: { id: locals.user!.id, email: locals.user!.email },
				action: 'revoke_user_api_key',
				targetUserId: params.id,
				payload: { keyId: existing.id, keyName: existing.name, keyPrefix: existing.prefix }
			},
			tx
		);
	});

	return json({ revoked: existing.id });
};
