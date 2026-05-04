import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';
import { fontAssetWhere, deriveFontFamily, scopedFontFamily } from '$lib/server/user-fonts';

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
	const items = rows.map((a) => {
		const displayName = deriveFontFamily(a.filename);
		return {
			id: a.id,
			filename: a.filename,
			/** What the editor's font picker shows — the human-readable
			 *  derived name. */
			displayName,
			/** What gets stored in templateJson and registered with both
			 *  the browser FontFace API and the server-side GlobalFonts.
			 *  Namespaced with the owner id so two users (or the same
			 *  user across re-uploads with the same filename) can't
			 *  collide in the process-global registry. */
			family: scopedFontFamily(locals.user!.id, displayName),
			url: storage.getUrl(a.storageKey),
			contentType: a.contentType,
			sizeBytes: a.sizeBytes,
			createdAt: a.createdAt
		};
	});

	return json({ items });
};
