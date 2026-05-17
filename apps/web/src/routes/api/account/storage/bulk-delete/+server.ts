/**
 * POST /api/account/storage/bulk-delete
 *
 * Session-cookie-authenticated. Soft-deletes every live render row for
 * the current user in a single UPDATE and best-effort cleans up the
 * matching storage blobs. The sweep CLI (TASK-175) handles any blobs
 * left behind by storage hiccups.
 *
 * Single-query semantics matter here: a per-shortId loop driven from
 * the client (as the original TASK-173 spec suggested) would race
 * itself if the user clicked twice, and would hold the UI for tens of
 * seconds at quota. A single UPDATE … RETURNING storage_key is atomic
 * relative to other concurrent calls.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { renderedImages } from '$lib/server/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	// Soft-delete every live row, returning the storage keys so we can
	// best-effort delete the blobs in a parallel sweep below.
	const rows = await db
		.update(renderedImages)
		.set({ deletedAt: new Date() })
		.where(and(eq(renderedImages.userId, locals.user.id), isNull(renderedImages.deletedAt)))
		.returning({ storageKey: renderedImages.storageKey });

	// Best-effort blob cleanup, in parallel but bounded. Each delete
	// catches its own error so a single storage hiccup doesn't tank
	// the rest of the batch. The DB row is the source of truth — any
	// blob left behind is reaped by the sweep CLI on its next run.
	const storage = getStorage();
	await Promise.all(
		rows.map((row) =>
			storage.delete(row.storageKey).catch((err) => {
				console.warn(
					`[account/storage/bulk-delete] storage delete failed key=${row.storageKey}`,
					err instanceof Error ? err.message : err
				);
			})
		)
	);

	return json({ deleted: rows.length });
};
