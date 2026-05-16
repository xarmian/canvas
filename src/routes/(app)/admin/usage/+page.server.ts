import { and, gte, lt, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { renderEvents } from '$lib/server/db/schema';
import { getInstanceRenderUsage, resolveDateRange } from '$lib/server/render-events';

/** Sources we expect on the stacked chart — explicit list so the legend
 *  stays stable when a particular source has zero events for the window. */
const KNOWN_SOURCES = ['on-the-fly', 'baked-api', 'baked-app', 'preview'] as const;
type KnownSource = (typeof KNOWN_SOURCES)[number];

const TOP_LIMIT = 5;

/**
 * /admin/usage — instance-wide render activity for the last 30 days.
 *
 * Auth gating: `src/routes/(app)/admin/+layout.server.ts` already enforces
 * `requireAdmin(locals.user)`; this page-level load runs only after that
 * gate passes. No extra check needed here.
 *
 * Queries fire in parallel (Promise.all) so the page settles inside the
 * <500ms acceptance bar even at ~10k events. Each query is bounded by
 * the SAME resolved `[from, to)` window via `resolveDateRange(undefined)`
 * so chart + tiles + tables can never disagree on which day a boundary
 * event lands in.
 */
export const load: PageServerLoad = async () => {
	const range = resolveDateRange();

	// Six queries; all read the same time window. None mutate.
	const [usage, sourceRows, instanceTiles, topCanvasRows, topUserRows, topApiKeyRows] =
		await Promise.all([
			// (1) byDay (zero-filled), cacheHitRate, total — reused from /account/usage.
			//     We could also use this helper's `topCanvases` / `topUsers` /
			//     `topApiKeys`, but those don't carry owner emails / hit rates /
			//     prefix / last-429 that the admin tables show — easier to do
			//     dedicated queries below than to grow the public helper.
			getInstanceRenderUsage(range),

			// (2) by-day × source for the stacked chart. Same canonicalization
			//     as `/account/usage` so the two surfaces look identical.
			db
				.select({
					date: sql<string>`to_char(date_trunc('day', ${renderEvents.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
					source: renderEvents.source,
					total: sql<number>`COUNT(*)::int`
				})
				.from(renderEvents)
				.where(and(gte(renderEvents.createdAt, range.from), lt(renderEvents.createdAt, range.to)))
				.groupBy(
					sql`to_char(date_trunc('day', ${renderEvents.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
					renderEvents.source
				)
				.orderBy(
					sql`to_char(date_trunc('day', ${renderEvents.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`
				),

			// (3) Instance-level tile aggregates not covered by the helper:
			//     distinct active users, distinct active API keys, p95 duration.
			//     Single sweep over the windowed slice — `percentile_cont`
			//     scans alongside the COUNT DISTINCTs at no extra cost.
			db.execute<{
				distinct_users: number | string;
				distinct_api_keys: number | string;
				p95_ms: number | string | null;
			}>(sql`
				SELECT
					COUNT(DISTINCT owner_user_id)::int AS distinct_users,
					COUNT(DISTINCT api_key_id)::int    AS distinct_api_keys,
					percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms
				FROM render_events
				WHERE created_at >= ${range.from} AND created_at < ${range.to}
			`),

			// (4) Top canvases with owner email + hit rate. Hit rate is
			//     computed inline (FILTER agg) so we don't loop in JS.
			db.execute<{
				canvas_id: string;
				canvas_name: string | null;
				owner_email: string | null;
				total: number | string;
				hits: number | string;
				qualifying: number | string;
			}>(sql`
				SELECT
					re.canvas_id AS canvas_id,
					c.name AS canvas_name,
					u.email AS owner_email,
					COUNT(*)::int AS total,
					COUNT(*) FILTER (WHERE re.cache_hit AND re.status_code < 400)::int AS hits,
					COUNT(*) FILTER (WHERE re.status_code < 400)::int AS qualifying
				FROM render_events re
				LEFT JOIN canvases c ON c.id = re.canvas_id
				LEFT JOIN "user" u   ON u.id = re.owner_user_id
				WHERE re.created_at >= ${range.from} AND re.created_at < ${range.to}
					AND re.canvas_id IS NOT NULL
				GROUP BY re.canvas_id, c.name, u.email
				ORDER BY total DESC
				LIMIT ${TOP_LIMIT}
			`),

			// (5) Top users with hit rate.
			db.execute<{
				user_id: string;
				email: string | null;
				total: number | string;
				hits: number | string;
				qualifying: number | string;
			}>(sql`
				SELECT
					re.owner_user_id AS user_id,
					u.email AS email,
					COUNT(*)::int AS total,
					COUNT(*) FILTER (WHERE re.cache_hit AND re.status_code < 400)::int AS hits,
					COUNT(*) FILTER (WHERE re.status_code < 400)::int AS qualifying
				FROM render_events re
				LEFT JOIN "user" u ON u.id = re.owner_user_id
				WHERE re.created_at >= ${range.from} AND re.created_at < ${range.to}
					AND re.owner_user_id IS NOT NULL
				GROUP BY re.owner_user_id, u.email
				ORDER BY total DESC
				LIMIT ${TOP_LIMIT}
			`),

			// (6) Top API keys with name + prefix + owner email + last-429.
			db.execute<{
				api_key_id: string;
				api_key_name: string | null;
				api_key_prefix: string | null;
				owner_email: string | null;
				total: number | string;
				last_429: Date | string | null;
			}>(sql`
				SELECT
					re.api_key_id AS api_key_id,
					k.name AS api_key_name,
					k.prefix AS api_key_prefix,
					u.email AS owner_email,
					COUNT(*)::int AS total,
					MAX(re.created_at) FILTER (WHERE re.status_code = 429) AS last_429
				FROM render_events re
				LEFT JOIN api_keys k ON k.id = re.api_key_id
				LEFT JOIN "user" u   ON u.id = k.user_id
				WHERE re.created_at >= ${range.from} AND re.created_at < ${range.to}
					AND re.api_key_id IS NOT NULL
				GROUP BY re.api_key_id, k.name, k.prefix, u.email
				ORDER BY total DESC
				LIMIT ${TOP_LIMIT}
			`)
		]);

	// Materialize the chart series: one Number per source per day.
	const bySource = new Map<string, Record<string, number>>();
	for (const r of sourceRows) {
		const bucket = bySource.get(r.date) ?? {};
		bucket[r.source] = Number(r.total);
		bySource.set(r.date, bucket);
	}
	const dateLabels = usage.byDay.map((d) => d.date);
	const chartSeries: { source: KnownSource; data: number[] }[] = KNOWN_SOURCES.map((source) => ({
		source,
		data: dateLabels.map((date) => bySource.get(date)?.[source] ?? 0)
	}));

	const tileRow = instanceTiles[0] ?? {
		distinct_users: 0,
		distinct_api_keys: 0,
		p95_ms: null
	};

	// Helper: turn the per-row hit/qualifying counts into a 0..1 ratio or
	// null when there are no qualifying events. Mirrors
	// `computeCacheHitRate` from `$lib/server/render-events` so the math
	// is identical to the tile-level rate the page also shows.
	function ratio(hits: number, qualifying: number): number | null {
		if (qualifying <= 0) return null;
		return hits / qualifying;
	}

	const topCanvases = topCanvasRows.map((r) => ({
		canvasId: r.canvas_id,
		canvasName: r.canvas_name,
		ownerEmail: r.owner_email,
		total: Number(r.total),
		hitRate: ratio(Number(r.hits), Number(r.qualifying))
	}));

	const topUsers = topUserRows.map((r) => ({
		userId: r.user_id,
		email: r.email,
		total: Number(r.total),
		hitRate: ratio(Number(r.hits), Number(r.qualifying))
	}));

	const topApiKeys = topApiKeyRows.map((r) => ({
		apiKeyId: r.api_key_id,
		apiKeyName: r.api_key_name,
		apiKeyPrefix: r.api_key_prefix,
		ownerEmail: r.owner_email,
		total: Number(r.total),
		last429At: r.last_429 ? new Date(r.last_429).toISOString() : null
	}));

	return {
		usage: {
			total: usage.total,
			cacheHitRate: usage.cacheHitRate
		},
		tiles: {
			distinctUsers: Number(tileRow.distinct_users ?? 0),
			distinctApiKeys: Number(tileRow.distinct_api_keys ?? 0),
			p95DurationMs: tileRow.p95_ms === null ? null : Number(tileRow.p95_ms)
		},
		chart: {
			labels: dateLabels,
			series: chartSeries
		},
		topCanvases,
		topUsers,
		topApiKeys
	};
};
