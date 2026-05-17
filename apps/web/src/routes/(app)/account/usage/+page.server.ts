import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { renderEvents } from '$lib/server/db/schema';
import { getUserRenderUsage, resolveDateRange } from '$lib/server/render-events';

/** Sources we expect to see in the chart legend. Listed here (rather
 *  than derived from the query) so the order — and the empty-state
 *  layout — stays stable when a particular source happens to have zero
 *  events in the window. */
const KNOWN_SOURCES = ['on-the-fly', 'baked-api', 'baked-app', 'preview'] as const;
type KnownSource = (typeof KNOWN_SOURCES)[number];

/**
 * /account/usage — render activity over the last 30 days.
 *
 * Auth gating is provided by the section `+layout.server.ts` (which
 * defers to the app-shell layout's session-only gate). We read the
 * aggregates here and let the client render the chart + tables.
 *
 * Two queries fire:
 *
 *   1. `getUserRenderUsage(userId, range)` — totals, hit rate, top-5
 *      canvases, top-5 API keys, and the per-day total series.
 *   2. An inline by-day-by-source breakdown — used to stack the chart.
 *      Kept inline here (rather than pushed into `$lib/server/render-events`)
 *      because no other surface needs the source-stacked shape today;
 *      promoting it to the helper module is one line of refactor when
 *      `/admin/usage` lands.
 *
 * Both queries are bounded by the SAME resolved `[from, to)` window
 * so the chart and the tiles can never disagree about which day a
 * boundary event lands in.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;
	// Resolve the window once and pass it to both queries — see note above.
	const range = resolveDateRange();
	const usage = await getUserRenderUsage(userId, range);

	const sourceRows = await db
		.select({
			date: sql<string>`to_char(date_trunc('day', ${renderEvents.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
			source: renderEvents.source,
			total: sql<number>`COUNT(*)::int`
		})
		.from(renderEvents)
		.where(
			and(
				eq(renderEvents.ownerUserId, userId),
				gte(renderEvents.createdAt, range.from),
				lt(renderEvents.createdAt, range.to)
			)
		)
		.groupBy(
			sql`to_char(date_trunc('day', ${renderEvents.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
			renderEvents.source
		)
		.orderBy(
			sql`to_char(date_trunc('day', ${renderEvents.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`
		);

	// Build a Map<date, Record<source, count>> so the page can zip it
	// against the full day list without doing N lookups per render.
	const bySource = new Map<string, Record<string, number>>();
	for (const r of sourceRows) {
		const bucket = bySource.get(r.date) ?? {};
		bucket[r.source] = Number(r.total);
		bySource.set(r.date, bucket);
	}

	// Materialize the chart series in load (not in the page) so the
	// hydration payload is as small as possible — one Number per source
	// per day, rather than the raw row list.
	const dateLabels = usage.byDay.map((d) => d.date);
	const chartSeries: { source: KnownSource; data: number[] }[] = KNOWN_SOURCES.map((source) => ({
		source,
		data: dateLabels.map((date) => bySource.get(date)?.[source] ?? 0)
	}));

	return {
		usage,
		chart: {
			labels: dateLabels,
			series: chartSeries
		}
	};
};
