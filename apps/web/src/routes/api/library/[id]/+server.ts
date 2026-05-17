import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';
import { forgetUserFontRegistration } from '$lib/server/user-fonts';

/**
 * DELETE /api/library/[id] — remove an asset from storage and the DB.
 *
 * Hard delete. Storage delete is best-effort (failure logged but DB row
 * is still removed) so an orphaned storage object won't block the user
 * from clearing their library — orphans are recoverable, but a row that
 * keeps re-appearing in the UI is a worse experience.
 *
 * Note: we deliberately do NOT block on canvases that reference this
 * asset. The /assets UI surfaces the usage list ahead of time via
 * GET .../usage so the user sees the consequences before confirming.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const [asset] = await db
		.select()
		.from(assets)
		.where(and(eq(assets.id, params.id), eq(assets.userId, locals.user.id)))
		.limit(1);

	if (!asset) error(404, 'Asset not found');

	const storage = getStorage();
	try {
		await storage.delete(asset.storageKey);
	} catch (err) {
		// Log but proceed — see comment above. Surfacing a 500 to the user
		// when the DB delete would still succeed is worse UX.
		console.error('[library] storage.delete failed', { storageKey: asset.storageKey, err });
	}

	await db.delete(assets).where(eq(assets.id, asset.id));

	// Invalidate the in-process font-registration tracking so a future
	// re-upload with the same derived family name re-registers fresh
	// bytes (no-op for non-font assets — the Set just doesn't contain
	// them).
	forgetUserFontRegistration(asset.id);

	return json({ success: true });
};
