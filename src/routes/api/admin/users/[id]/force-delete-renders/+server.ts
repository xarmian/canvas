/**
 * POST /api/admin/users/[id]/force-delete-renders
 *
 * Admin power-action (TASK-186 / PLAN-180): soft-delete every live
 * rendered_image owned by the target user in a single UPDATE, then
 * best-effort cleanup the storage blobs.
 *
 * Auth is enforced server-side here — we do NOT rely on UI gating. The
 * `requireAdmin` check throws 403 before we touch any data, and the
 * audit-log row is written only after the UPDATE succeeds so a
 * forbidden caller leaves no trace.
 *
 * Soft-delete semantics match `/api/account/storage/bulk-delete`: rows
 * get `deleted_at` set and the sweep CLI hard-deletes past the grace
 * window. Single-query UPDATE means a double-click can't race itself.
 */
import { error, json } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { renderedImages, user } from '$lib/server/db/schema';
import { requireAdmin } from '$lib/server/admin';
import { recordAdminAction } from '$lib/server/admin-audit';
import { getStorage } from '$lib/server/storage';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user || !locals.session) error(401, 'Unauthorized');
	requireAdmin(locals.user);

	// 404 before doing anything destructive so a typo in the path
	// param doesn't get treated as "no rows to delete; success."
	const targetRows = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.id, params.id))
		.limit(1);
	if (!targetRows[0]) error(404, 'User not found');

	const deleted = await db
		.update(renderedImages)
		.set({ deletedAt: new Date() })
		.where(and(eq(renderedImages.userId, params.id), isNull(renderedImages.deletedAt)))
		.returning({ storageKey: renderedImages.storageKey });

	// Best-effort parallel blob cleanup. Each delete swallows its own
	// error so a single storage hiccup doesn't tank the batch; the DB
	// row is the source of truth and the sweep CLI reaps leftovers.
	const storage = getStorage();
	await Promise.all(
		deleted.map((row) =>
			storage.delete(row.storageKey).catch((err) => {
				console.warn(
					`[admin/force-delete-renders] storage delete failed key=${row.storageKey}`,
					err instanceof Error ? err.message : err
				);
			})
		)
	);

	await recordAdminAction({
		actor: { id: locals.user.id, email: locals.user.email },
		action: 'force_delete_user_renders',
		targetUserId: params.id,
		payload: { deletedRenderCount: deleted.length }
	});

	return json({ deleted: deleted.length });
};
