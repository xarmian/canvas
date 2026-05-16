import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { assets, canvases } from '$lib/server/db/schema';
import { and, eq, desc, like, sql } from 'drizzle-orm';
import { getCanvasRenderUsageBatch } from '$lib/server/render-events';

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

	// Per-canvas render counts for the "renders (30d)" badge (TASK-196).
	// ONE query for the whole list — the batch helper short-circuits on
	// an empty id list, so the empty-dashboard case stays free. Canvases
	// with zero events come back with `{ total: 0 }` so the card can
	// render `↻ 0 (30d)` explicitly rather than hiding the badge.
	const canvasIds = userCanvases.map((c) => c.id);
	const renderTotals = await getCanvasRenderUsageBatch(canvasIds);
	const renderCounts: Record<string, number> = {};
	for (const id of canvasIds) {
		renderCounts[id] = renderTotals.get(id)?.total ?? 0;
	}

	return { canvases: userCanvases, assetCount, renderCounts };
};
