import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { assets, canvases } from '$lib/server/db/schema';
import { and, eq, desc, like, sql } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	// Fetch the canvases list and the asset-library count in parallel.
	// The count drives the "Assets" tile on the dashboard sidebar
	// (TASK-103) — first-time users discover the library here instead
	// of having to spot it in the top nav.
	const userCanvases = await db
		.select({
			id: canvases.id,
			name: canvases.name,
			slug: canvases.slug,
			width: canvases.width,
			height: canvases.height,
			published: canvases.published,
			folder: canvases.folder,
			tags: canvases.tags,
			updatedAt: canvases.updatedAt
		})
		.from(canvases)
		.where(eq(canvases.userId, userId))
		.orderBy(desc(canvases.updatedAt));

	// Image assets only — fonts use their own management surface
	// (TASK-63) and shouldn't inflate the user-facing tile count.
	const [{ assetCount }] = await db
		.select({ assetCount: sql<number>`count(*)::int` })
		.from(assets)
		.where(and(eq(assets.userId, userId), like(assets.contentType, 'image/%')));

	return { canvases: userCanvases, assetCount };
};
