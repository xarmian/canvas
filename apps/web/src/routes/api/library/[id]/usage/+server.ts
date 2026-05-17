import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets, canvases } from '$lib/server/db/schema';
import { eq, and, or, sql } from 'drizzle-orm';

/**
 * GET /api/library/[id]/usage — list the user's canvases that reference
 * this asset in their templateJson. Used by the /assets delete flow to
 * warn the user before they remove an asset that's still in use.
 *
 * Detection covers TWO reference forms:
 *
 *   1. Resolved URL containing the storageKey — the legacy form when the
 *      editor saved absolute storage URLs into templateJson.
 *
 *   2. `asset://{id}` portable reference (TASK-116) — the editor now saves
 *      library-linked images this way, and the server-side resolver
 *      translates them at render time. Without matching this form too,
 *      the delete warning would silently miss every canvas that picked
 *      from the library after TASK-116 shipped.
 *
 * Both predicates are substring matches on `templateJson::text`.
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
	const storageKeyPattern = `%${asset.storageKey}%`;
	// The portable `asset://{id}` form. Substring rather than exact match
	// so the predicate hits regardless of which JSON field (src,
	// fallbackSrc, iconImage) carries the reference.
	const assetUrlPattern = `%asset://${asset.id}%`;

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
				or(
					sql`${canvases.templateJson}::text LIKE ${storageKeyPattern}`,
					sql`${canvases.templateJson}::text LIKE ${assetUrlPattern}`
				)
			)
		);

	return json({ usedIn });
};
