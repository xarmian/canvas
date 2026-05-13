import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';

const PAGE_SIZE = 50;

/**
 * Instance-admin storage view. Admin gating happens in the parent
 * `/admin/+layout.server.ts`; this load assumes the caller is already
 * confirmed admin.
 *
 * The per-user query joins user → rendered_images with `deleted_at IS
 * NULL` filtered in the JOIN predicate (so users with zero live rows
 * still appear via LEFT JOIN, then the HAVING clause drops them). The
 * pagination uses offset (not cursor) because admin pages are
 * navigated linearly and have small expected scale (≤ a few thousand
 * active users in v1) — cursor pagination would be overkill.
 */
export const load: PageServerLoad = async ({ url }) => {
	const rawOffset = Number(url.searchParams.get('offset') ?? 0);
	const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

	type PerUserRow = {
		id: string;
		email: string;
		render_count: number;
		total_bytes: string | number;
		last_active_at: Date | string | null;
	};
	const perUserRows = await db.execute<PerUserRow>(sql`
        SELECT
          u.id, u.email,
          COUNT(r.id)::int                       AS render_count,
          COALESCE(SUM(r.size_bytes), 0)::bigint AS total_bytes,
          MAX(r.last_accessed_at)                AS last_active_at
        FROM "user" u
        LEFT JOIN rendered_images r
          ON r.user_id = u.id AND r.deleted_at IS NULL
        GROUP BY u.id, u.email
        HAVING COUNT(r.id) > 0
        -- u.id is the deterministic tie-breaker: two users with the
        -- same (total_bytes, render_count) tuple would otherwise appear
        -- in unstable order across offset pages, producing duplicates
        -- or skips on Next/Prev (Codex review round 1).
        ORDER BY total_bytes DESC, render_count DESC, u.id ASC
        LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `);
	const perUser = perUserRows.map((row) => ({
		id: row.id,
		email: row.email,
		renderCount: Number(row.render_count ?? 0),
		totalBytes: Number(row.total_bytes ?? 0),
		lastActiveAt: row.last_active_at ? new Date(row.last_active_at).toISOString() : null
	}));

	type TotalsRow = {
		total_renders: number;
		total_bytes: string | number;
		active_users: number;
	};
	const totalsRows = await db.execute<TotalsRow>(sql`
        SELECT
          COUNT(*)::int                          AS total_renders,
          COALESCE(SUM(size_bytes), 0)::bigint   AS total_bytes,
          COUNT(DISTINCT user_id)::int           AS active_users
        FROM rendered_images
        WHERE deleted_at IS NULL
    `);
	const totalsRow = totalsRows[0] ?? { total_renders: 0, total_bytes: 0, active_users: 0 };
	const totals = {
		totalRenders: Number(totalsRow.total_renders ?? 0),
		totalBytes: Number(totalsRow.total_bytes ?? 0),
		activeUsers: Number(totalsRow.active_users ?? 0)
	};

	type KeysRow = { active_keys: number };
	const keysRows = await db.execute<KeysRow>(sql`
        SELECT COUNT(*)::int AS active_keys
        FROM api_keys
        WHERE revoked_at IS NULL
    `);
	const activeKeys = Number(keysRows[0]?.active_keys ?? 0);

	// `EXISTS (SELECT 1 ... OFFSET N)` is cheaper than counting total
	// distinct users when the answer is "there's at least one more
	// page" — we don't need the exact tail length.
	type MoreRow = { more: boolean };
	const moreRows = await db.execute<MoreRow>(sql`
        SELECT EXISTS (
          SELECT 1 FROM rendered_images
          WHERE deleted_at IS NULL
          GROUP BY user_id
          OFFSET ${offset + PAGE_SIZE}
        ) AS more
    `);
	const hasMore = Boolean(moreRows[0]?.more);

	return {
		perUser,
		totals,
		activeKeys,
		offset,
		pageSize: PAGE_SIZE,
		hasMore
	};
};
