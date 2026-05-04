import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';
import { fontAssetWhere, deriveFontFamily } from '$lib/server/user-fonts';

/**
 * GET /api/fonts — list the current user's uploaded font assets.
 * Returns each row with the derived family name (filename minus
 * extension) so both the editor's font picker and any future server
 * caller can use the same canonical family. Newest-first sort.
 *
 * Delete uses the existing /api/library/[id] endpoint — fonts are
 * just assets, and the user already authorizes by owner there.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const rows = await db
		.select()
		.from(assets)
		.where(and(eq(assets.userId, locals.user.id), fontAssetWhere()))
		.orderBy(desc(assets.createdAt));

	const storage = getStorage();
	const items = rows.map((a) => ({
		id: a.id,
		filename: a.filename,
		family: deriveFontFamily(a.filename),
		url: storage.getUrl(a.storageKey),
		contentType: a.contentType,
		sizeBytes: a.sizeBytes,
		createdAt: a.createdAt
	}));

	return json({ items });
};
