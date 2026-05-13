import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { canvases, renderedImages } from '$lib/server/db/schema';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

/**
 * /account/storage — user-facing storage utilization page.
 *
 * Auth gating is provided by the section `+layout.server.ts` (which itself
 * defers to the app-shell layout's session-only gate). We just read the
 * stats here.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	// Aggregate stats over the user's live (non-deleted) renders. Cast
	// `total_bytes` to bigint at the DB so a row containing very large
	// blobs doesn't overflow JS's safe-integer range during aggregation.
	// `postgres-js` returns bigints as strings; we convert at the
	// boundary so the client receives a regular number.
	const aggRows = await db.execute<{
		render_count: number;
		total_bytes: string | number;
		oldest_created: Date | null;
		most_recent_access: Date | null;
	}>(sql`
        SELECT
          COUNT(*)::int                AS render_count,
          COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes,
          MIN(created_at)              AS oldest_created,
          MAX(last_accessed_at)        AS most_recent_access
        FROM rendered_images
        WHERE user_id = ${userId} AND deleted_at IS NULL
    `);
	const agg = aggRows[0] ?? {
		render_count: 0,
		total_bytes: 0,
		oldest_created: null,
		most_recent_access: null
	};

	const stats = {
		renderCount: Number(agg.render_count ?? 0),
		totalBytes: Number(agg.total_bytes ?? 0),
		oldestCreatedAt: agg.oldest_created ? new Date(agg.oldest_created).toISOString() : null,
		mostRecentAccessAt: agg.most_recent_access
			? new Date(agg.most_recent_access).toISOString()
			: null
	};

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
