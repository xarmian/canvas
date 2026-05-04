import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets, canvases } from '$lib/server/db/schema';
import { eq, and, sql } from 'drizzle-orm';

/**
 * GET /api/library/[id]/usage — list the user's canvases that reference
 * this asset's storage key in their templateJson. Best-effort: matches by
 * substring of the storage key (the key is part of every URL Fabric stored
 * for the asset, regardless of whether storage is local or S3-backed).
 *
 * Used by the /assets delete flow to warn the user before they remove an
 * asset that's still in use.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const [asset] = await db
		.select()
		.from(assets)
		.where(and(eq(assets.id, params.id), eq(assets.userId, locals.user.id)))
		.limit(1);

	if (!asset) error(404, 'Asset not found');

	// Cast templateJson to text and substring-match. Stable across both
	// /api/assets/<key> (local) and https://.../<key> (S3) URL shapes
	// because the key contains a unique nanoid segment.
	const matchPattern = `%${asset.storageKey}%`;
	const usedIn = await db
		.select({
			id: canvases.id,
			name: canvases.name,
			slug: canvases.slug,
			published: canvases.published
		})
		.from(canvases)
		.where(
			and(
				eq(canvases.userId, locals.user.id),
				sql`${canvases.templateJson}::text LIKE ${matchPattern}`
			)
		);

	return json({ usedIn });
};
