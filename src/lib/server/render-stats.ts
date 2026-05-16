/**
 * Per-user rendered-image storage aggregates.
 *
 * Shared between `/account/storage` (session user) and
 * `/admin/users/[id]` (target user) so the two pages always agree on
 * what "renders / total bytes / oldest / most-recent-used" means.
 * Originally inlined into `/account/storage/+page.server.ts`; extracted
 * here when the admin per-user drilldown (PLAN-180 / TASK-183) needed
 * the same shape scoped to a different user id.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { canvases, renderedImages } from '$lib/server/db/schema';

export type UserRenderStats = {
	renderCount: number;
	totalBytes: number;
	oldestCreatedAt: string | null;
	mostRecentAccessAt: string | null;
};

/**
 * Aggregate live (non-deleted) rendered_images for `userId`.
 *
 * The SUM is cast to bigint at the DB so a single very large blob
 * doesn't overflow JS's safe-integer range during aggregation.
 * `postgres-js` returns bigints as strings; we convert at the boundary
 * so callers receive a regular number.
 */
export async function getUserRenderStats(userId: string): Promise<UserRenderStats> {
	const rows = await db.execute<{
		render_count: number;
		total_bytes: string | number;
		oldest_created: Date | string | null;
		most_recent_access: Date | string | null;
	}>(sql`
        SELECT
          COUNT(*)::int                          AS render_count,
          COALESCE(SUM(size_bytes), 0)::bigint   AS total_bytes,
          MIN(created_at)                        AS oldest_created,
          MAX(last_accessed_at)                  AS most_recent_access
        FROM rendered_images
        WHERE user_id = ${userId} AND deleted_at IS NULL
    `);
	const agg = rows[0] ?? {
		render_count: 0,
		total_bytes: 0,
		oldest_created: null,
		most_recent_access: null
	};
	return {
		renderCount: Number(agg.render_count ?? 0),
		totalBytes: Number(agg.total_bytes ?? 0),
		oldestCreatedAt: agg.oldest_created ? new Date(agg.oldest_created).toISOString() : null,
		mostRecentAccessAt: agg.most_recent_access
			? new Date(agg.most_recent_access).toISOString()
			: null
	};
}

export type RecentRender = {
	shortId: string;
	canvasName: string | null;
	sizeBytes: number;
	format: string;
	createdAt: string;
	lastAccessedAt: string;
};

/**
 * Most recently used live renders for `userId`, ordered by
 * last_accessed_at descending. Shape matches what /account/storage
 * has historically rendered so the same row component works whether
 * the page is the session user's own storage or the admin drilldown
 * for a target user.
 */
export async function getUserRecentRenders(userId: string, limit = 10): Promise<RecentRender[]> {
	const rows = await db
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
		.limit(limit);
	return rows.map((r) => ({
		shortId: r.shortId,
		canvasName: r.canvasName,
		sizeBytes: r.sizeBytes,
		format: r.format,
		createdAt: r.createdAt.toISOString(),
		lastAccessedAt: r.lastAccessedAt.toISOString()
	}));
}
