import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { canvases, renderedImages } from '$lib/server/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getUserRenderStats } from '$lib/server/render-stats';

/**
 * /account/storage — user-facing storage utilization page.
 *
 * Auth gating is provided by the section `+layout.server.ts` (which itself
 * defers to the app-shell layout's session-only gate). We just read the
 * stats here.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	// Aggregate stats over the user's live (non-deleted) renders.
	// Shared with /admin/users/[id]'s drilldown so the two pages stay
	// in sync on what "renders / bytes / oldest / most-recent" means.
	const stats = await getUserRenderStats(userId);

	// Recent 10 renders by last-accessed (the user's most-used permalinks).
	// Sized for a single-screen card; the full list is a follow-up.
	const recent = await db
		.select({
			shortId: renderedImages.shortId,
			canvasName: canvases.name,
			sizeBytes: renderedImages.sizeBytes,
			format: renderedImages.format,
			createdAt: renderedImages.createdAt,
			lastAccessedAt: renderedImages.lastAccessedAt
		})
		.from(renderedImages)
		.leftJoin(canvases, eq(canvases.id, renderedImages.canvasId))
		.where(and(eq(renderedImages.userId, userId), isNull(renderedImages.deletedAt)))
		.orderBy(desc(renderedImages.lastAccessedAt))
		.limit(10);

	const quota = Number((env as Record<string, string | undefined>).RENDER_QUOTA_PER_USER ?? 1000);

	return {
		stats,
		quota,
		recent: recent.map((r) => ({
			...r,
			createdAt: r.createdAt.toISOString(),
			lastAccessedAt: r.lastAccessedAt.toISOString()
		}))
	};
};
