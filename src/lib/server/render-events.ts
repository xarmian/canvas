/**
 * Query layer + write helper for the `render_events` append-only log.
 *
 * Every render path (on-the-fly, baked API, baked app, preview) emits one
 * row via `recordRenderEvent`; the per-canvas / per-key / per-account
 * surface pages and the instance-wide admin dashboard read aggregates
 * through the `get*RenderUsage` helpers. Keeping the SQL here (rather than
 * open-coding it in each `+page.server.ts`) means cache-hit-rate
 * semantics, the 30-day default window, and zero-render-day gap-filling
 * are guaranteed identical across every caller.
 *
 * Design notes (TASK-191):
 *
 * - The query helpers are pure with respect to the SvelteKit env — only
 *   `recordRenderEvent` reads `RENDER_EVENTS_IP_SALT`. The `client`
 *   parameter is injectable so the helpers are unit-testable without a
 *   live Postgres; full SQL coverage lives in the e2e suite.
 * - `recordRenderEvent` is fire-and-forget safe. It catches and logs any
 *   exception, never letting an observability write break the render
 *   response path. Callers may `await` or `void` it; the contract is the
 *   same either way.
 * - `byDay` returns one bucket per day in the requested range (inclusive
 *   of zero-render days) so charting consumers don't have to backfill.
 * - The cache-hit rate excludes events with `status_code >= 400` because
 *   errors are neither hits nor misses; treating them as misses would
 *   spuriously drag the rate down on a bad day.
 * - Per-key `last429At` / `lastErrorAt` are derived inline (max(created_at)
 *   filtered by status code) rather than maintained as a separate
 *   counter, so they're always consistent with the event log.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db as defaultDb } from './db';
import { renderEvents } from './db/schema';

/** Public alias for the drizzle client shape so call sites + tests can
 *  inject a stand-in without depending on the postgres-js generic. */
export type RenderEventDb = typeof defaultDb;

/** Inputs to the date-windowed query helpers. `from` is inclusive; `to`
 *  is exclusive (i.e. a typical "last N full days" window passes
 *  `from = startOfDayUTC(now - N*24h)` and `to = now`). When only `days`
 *  is provided the helper resolves it relative to "now". */
export type DateRangeOpts = {
	from?: Date;
	to?: Date;
	days?: number;
};

const DEFAULT_DAYS = 30;
const DEFAULT_TOP_N = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type DayBucket = { date: string; total: number };

export type TopCanvas = { canvasId: string; canvasName: string | null; total: number };
export type TopApiKey = { apiKeyId: string; apiKeyName: string | null; total: number };
export type TopUser = {
	userId: string;
	userName: string | null;
	userEmail: string | null;
	total: number;
};

export type UserRenderUsage = {
	byDay: DayBucket[];
	cacheHitRate: number | null;
	total: number;
	topCanvases: TopCanvas[];
	topApiKeys: TopApiKey[];
};

export type CanvasRenderUsage = {
	byDay: DayBucket[];
	cacheHitRate: number | null;
	total: number;
};

export type ApiKeyRenderUsage = {
	total: number;
	last429At: string | null;
	lastErrorAt: string | null;
	lastUsedAt: string | null;
};

export type InstanceRenderUsage = {
	byDay: DayBucket[];
	cacheHitRate: number | null;
	total: number;
	topCanvases: TopCanvas[];
	topUsers: TopUser[];
	topApiKeys: TopApiKey[];
};

export type RenderEventInput = {
	source: string;
	canvasId?: string | null;
	ownerUserId?: string | null;
	requesterUserId?: string | null;
	apiKeyId?: string | null;
	format: string;
	paramsHash: string;
	cacheHit: boolean;
	durationMs: number;
	statusCode: number;
	/** Raw IP. Hashed internally with `RENDER_EVENTS_IP_SALT` + UTC date.
	 *  `null`/`undefined` (or a missing salt) stores `ip_hash=null`. */
	ip?: string | null;
};

// ─── Pure helpers ────────────────────────────────────────────────────────────
// These are exported so the date-window + bucketing + ip-hash logic can be
// unit-tested without a live database — the actual SQL is exercised in e2e.

/**
 * Resolve a `DateRangeOpts` into concrete [from, to) UTC bounds.
 *
 * Precedence (`now` defaults to the current wall clock):
 *   - both `from` and `to` provided → use them as-is
 *   - only `from` → `to = now`
 *   - only `to`   → `from = to - days*24h` (days defaults to 30)
 *   - neither    → `from = now - days*24h`, `to = now`
 *
 * Throws on an inverted range (`from >= to`) so callers can't silently
 * dispatch a query that returns nothing — a misconfigured window is a
 * bug, not a zero-row response.
 */
export function resolveDateRange(
	opts?: DateRangeOpts,
	now: Date = new Date()
): { from: Date; to: Date } {
	const days = opts?.days ?? DEFAULT_DAYS;
	const to = opts?.to ?? now;
	const from = opts?.from ?? new Date(to.getTime() - days * MS_PER_DAY);
	if (!(from.getTime() < to.getTime())) {
		throw new Error(
			`resolveDateRange: from must be strictly before to (from=${from.toISOString()} to=${to.toISOString()})`
		);
	}
	return { from, to };
}

/** Format a Date as `YYYY-MM-DD` in UTC. */
export function utcDayString(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/**
 * Enumerate every UTC day that overlaps the `[from, to)` window as a
 * sorted list of `YYYY-MM-DD` strings. Used to zero-fill the `byDay`
 * results so chart consumers receive a contiguous series.
 */
export function enumerateDayBuckets(from: Date, to: Date): string[] {
	if (!(from.getTime() < to.getTime())) return [];
	const out: string[] = [];
	// Walk from the start-of-day containing `from` up to (but not past)
	// `to`. We compare on the day string itself to be DST-safe; the data
	// is UTC throughout.
	const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
	const endDay = utcDayString(new Date(to.getTime() - 1));
	while (utcDayString(cursor) <= endDay) {
		out.push(utcDayString(cursor));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return out;
}

/**
 * Merge a sparse list of (date, total) rows from the DB with the full
 * day enumeration so missing days get `total: 0`.
 */
export function fillDayBuckets(
	rows: ReadonlyArray<{ date: string; total: number }>,
	days: ReadonlyArray<string>
): DayBucket[] {
	const byDate = new Map<string, number>();
	for (const r of rows) byDate.set(r.date, r.total);
	return days.map((date) => ({ date, total: byDate.get(date) ?? 0 }));
}

/**
 * Compute a cache-hit rate as `hits / total`, ignoring error events
 * (filtering on `status_code < 400` is done at the SQL layer; this just
 * does the division safely).
 *
 * Returns `null` when there are no qualifying events — an empty window
 * has no meaningful hit rate, and "0%" would be misleading on a fresh
 * dashboard.
 */
export function computeCacheHitRate(hits: number, total: number): number | null {
	if (total <= 0) return null;
	return hits / total;
}

/**
 * Compute the per-event `ip_hash` value: sha256 over
 * `salt + ':' + yyyy-mm-dd + ':' + ip` in UTC.
 *
 * Returns `null` when either the salt or the IP is missing — the column
 * is nullable for exactly these cases (no salt configured at install
 * time, no IP available on the request). The day component rotates the
 * hash daily so the same IP is correlatable within a 24h window for
 * abuse-detection but not across days.
 */
export function computeIpHash(
	rawIp: string | null | undefined,
	salt: string | null | undefined,
	now: Date = new Date()
): string | null {
	if (!rawIp || !salt) return null;
	const day = utcDayString(now);
	return createHash('sha256').update(`${salt}:${day}:${rawIp}`).digest('hex');
}

// ─── Read-side: aggregate queries ────────────────────────────────────────────

/**
 * Per-account usage — powers `/account/usage`. Returns a zero-filled
 * `byDay` series, a hit rate (excluding errors), the total event count,
 * and the top-N canvases / API keys for the requested window.
 */
export async function getUserRenderUsage(
	userId: string,
	opts?: DateRangeOpts,
	client: RenderEventDb = defaultDb
): Promise<UserRenderUsage> {
	const { from, to } = resolveDateRange(opts);
	const days = enumerateDayBuckets(from, to);
	const [byDayRows, summaryRows, topCanvasRows, topApiKeyRows] = await Promise.all([
		client.execute<{ date: string; total: string | number }>(sql`
			SELECT
				to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
				COUNT(*)::int AS total
			FROM render_events
			WHERE owner_user_id = ${userId}
				AND created_at >= ${from}
				AND created_at < ${to}
			GROUP BY date
			ORDER BY date
		`),
		client.execute<{ hits: string | number; total: string | number }>(sql`
			SELECT
				COUNT(*) FILTER (WHERE cache_hit AND status_code < 400)::int AS hits,
				COUNT(*) FILTER (WHERE status_code < 400)::int AS total
			FROM render_events
			WHERE owner_user_id = ${userId}
				AND created_at >= ${from}
				AND created_at < ${to}
		`),
		client.execute<{ canvas_id: string; canvas_name: string | null; total: string | number }>(sql`
			SELECT
				re.canvas_id AS canvas_id,
				c.name AS canvas_name,
				COUNT(*)::int AS total
			FROM render_events re
			LEFT JOIN canvases c ON c.id = re.canvas_id
			WHERE re.owner_user_id = ${userId}
				AND re.created_at >= ${from}
				AND re.created_at < ${to}
				AND re.canvas_id IS NOT NULL
			GROUP BY re.canvas_id, c.name
			ORDER BY total DESC
			LIMIT ${DEFAULT_TOP_N}
		`),
		client.execute<{ api_key_id: string; api_key_name: string | null; total: string | number }>(sql`
			SELECT
				re.api_key_id AS api_key_id,
				k.name AS api_key_name,
				COUNT(*)::int AS total
			FROM render_events re
			LEFT JOIN api_keys k ON k.id = re.api_key_id
			WHERE re.owner_user_id = ${userId}
				AND re.created_at >= ${from}
				AND re.created_at < ${to}
				AND re.api_key_id IS NOT NULL
			GROUP BY re.api_key_id, k.name
			ORDER BY total DESC
			LIMIT ${DEFAULT_TOP_N}
		`)
	]);

	const sparseByDay = byDayRows.map((r) => ({ date: r.date, total: Number(r.total) }));
	const summary = summaryRows[0] ?? { hits: 0, total: 0 };
	const total = byDayRows.reduce((acc, r) => acc + Number(r.total), 0);

	return {
		byDay: fillDayBuckets(sparseByDay, days),
		cacheHitRate: computeCacheHitRate(Number(summary.hits), Number(summary.total)),
		total,
		topCanvases: topCanvasRows.map((r) => ({
			canvasId: r.canvas_id,
			canvasName: r.canvas_name,
			total: Number(r.total)
		})),
		topApiKeys: topApiKeyRows.map((r) => ({
			apiKeyId: r.api_key_id,
			apiKeyName: r.api_key_name,
			total: Number(r.total)
		}))
	};
}

/**
 * Per-canvas usage — powers the dashboard card + editor header badge.
 */
export async function getCanvasRenderUsage(
	canvasId: string,
	opts?: DateRangeOpts,
	client: RenderEventDb = defaultDb
): Promise<CanvasRenderUsage> {
	const { from, to } = resolveDateRange(opts);
	const days = enumerateDayBuckets(from, to);
	const [byDayRows, summaryRows] = await Promise.all([
		client.execute<{ date: string; total: string | number }>(sql`
			SELECT
				to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
				COUNT(*)::int AS total
			FROM render_events
			WHERE canvas_id = ${canvasId}
				AND created_at >= ${from}
				AND created_at < ${to}
			GROUP BY date
			ORDER BY date
		`),
		client.execute<{ hits: string | number; total: string | number }>(sql`
			SELECT
				COUNT(*) FILTER (WHERE cache_hit AND status_code < 400)::int AS hits,
				COUNT(*) FILTER (WHERE status_code < 400)::int AS total
			FROM render_events
			WHERE canvas_id = ${canvasId}
				AND created_at >= ${from}
				AND created_at < ${to}
		`)
	]);

	const sparseByDay = byDayRows.map((r) => ({ date: r.date, total: Number(r.total) }));
	const summary = summaryRows[0] ?? { hits: 0, total: 0 };
	const total = byDayRows.reduce((acc, r) => acc + Number(r.total), 0);
	return {
		byDay: fillDayBuckets(sparseByDay, days),
		cacheHitRate: computeCacheHitRate(Number(summary.hits), Number(summary.total)),
		total
	};
}

/**
 * Per-API-key counters used by `/account/api-keys` and the admin view.
 *
 * `lastUsedAt` here is the most recent *successful* render emitted by
 * the key (status_code < 400). The `api_keys.last_used_at` column,
 * by contrast, is bumped by the auth middleware on every call —
 * including 401s on revoked keys. Two different things; the auth-time
 * timestamp lives where it does because the render event hasn't been
 * recorded yet at that point.
 */
export async function getApiKeyRenderUsage(
	apiKeyId: string,
	opts?: DateRangeOpts,
	client: RenderEventDb = defaultDb
): Promise<ApiKeyRenderUsage> {
	const { from, to } = resolveDateRange(opts);
	const [row] = await client.execute<{
		total: string | number;
		last429: Date | string | null;
		last_error: Date | string | null;
		last_used: Date | string | null;
	}>(sql`
		SELECT
			COUNT(*)::int AS total,
			MAX(created_at) FILTER (WHERE status_code = 429) AS last429,
			MAX(created_at) FILTER (WHERE status_code >= 500) AS last_error,
			MAX(created_at) FILTER (WHERE status_code < 400) AS last_used
		FROM render_events
		WHERE api_key_id = ${apiKeyId}
			AND created_at >= ${from}
			AND created_at < ${to}
	`);
	const r = row ?? { total: 0, last429: null, last_error: null, last_used: null };
	return {
		total: Number(r.total ?? 0),
		last429At: r.last429 ? new Date(r.last429).toISOString() : null,
		lastErrorAt: r.last_error ? new Date(r.last_error).toISOString() : null,
		lastUsedAt: r.last_used ? new Date(r.last_used).toISOString() : null
	};
}

/**
 * Instance-wide usage — powers `/admin/usage`. Includes a `topUsers`
 * tile that the per-account variant doesn't (a user's own dashboard
 * shows their canvases / keys, not other users).
 */
export async function getInstanceRenderUsage(
	opts?: DateRangeOpts,
	client: RenderEventDb = defaultDb
): Promise<InstanceRenderUsage> {
	const { from, to } = resolveDateRange(opts);
	const days = enumerateDayBuckets(from, to);
	const [byDayRows, summaryRows, topCanvasRows, topUserRows, topApiKeyRows] = await Promise.all([
		client.execute<{ date: string; total: string | number }>(sql`
			SELECT
				to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
				COUNT(*)::int AS total
			FROM render_events
			WHERE created_at >= ${from} AND created_at < ${to}
			GROUP BY date
			ORDER BY date
		`),
		client.execute<{ hits: string | number; total: string | number }>(sql`
			SELECT
				COUNT(*) FILTER (WHERE cache_hit AND status_code < 400)::int AS hits,
				COUNT(*) FILTER (WHERE status_code < 400)::int AS total
			FROM render_events
			WHERE created_at >= ${from} AND created_at < ${to}
		`),
		client.execute<{ canvas_id: string; canvas_name: string | null; total: string | number }>(sql`
			SELECT
				re.canvas_id AS canvas_id,
				c.name AS canvas_name,
				COUNT(*)::int AS total
			FROM render_events re
			LEFT JOIN canvases c ON c.id = re.canvas_id
			WHERE re.created_at >= ${from} AND re.created_at < ${to}
				AND re.canvas_id IS NOT NULL
			GROUP BY re.canvas_id, c.name
			ORDER BY total DESC
			LIMIT ${DEFAULT_TOP_N}
		`),
		client.execute<{
			user_id: string;
			user_name: string | null;
			user_email: string | null;
			total: string | number;
		}>(sql`
			SELECT
				re.owner_user_id AS user_id,
				u.name AS user_name,
				u.email AS user_email,
				COUNT(*)::int AS total
			FROM render_events re
			LEFT JOIN "user" u ON u.id = re.owner_user_id
			WHERE re.created_at >= ${from} AND re.created_at < ${to}
				AND re.owner_user_id IS NOT NULL
			GROUP BY re.owner_user_id, u.name, u.email
			ORDER BY total DESC
			LIMIT ${DEFAULT_TOP_N}
		`),
		client.execute<{ api_key_id: string; api_key_name: string | null; total: string | number }>(sql`
			SELECT
				re.api_key_id AS api_key_id,
				k.name AS api_key_name,
				COUNT(*)::int AS total
			FROM render_events re
			LEFT JOIN api_keys k ON k.id = re.api_key_id
			WHERE re.created_at >= ${from} AND re.created_at < ${to}
				AND re.api_key_id IS NOT NULL
			GROUP BY re.api_key_id, k.name
			ORDER BY total DESC
			LIMIT ${DEFAULT_TOP_N}
		`)
	]);

	const sparseByDay = byDayRows.map((r) => ({ date: r.date, total: Number(r.total) }));
	const summary = summaryRows[0] ?? { hits: 0, total: 0 };
	const total = byDayRows.reduce((acc, r) => acc + Number(r.total), 0);
	return {
		byDay: fillDayBuckets(sparseByDay, days),
		cacheHitRate: computeCacheHitRate(Number(summary.hits), Number(summary.total)),
		total,
		topCanvases: topCanvasRows.map((r) => ({
			canvasId: r.canvas_id,
			canvasName: r.canvas_name,
			total: Number(r.total)
		})),
		topUsers: topUserRows.map((r) => ({
			userId: r.user_id,
			userName: r.user_name,
			userEmail: r.user_email,
			total: Number(r.total)
		})),
		topApiKeys: topApiKeyRows.map((r) => ({
			apiKeyId: r.api_key_id,
			apiKeyName: r.api_key_name,
			total: Number(r.total)
		}))
	};
}

// ─── Batch variants ──────────────────────────────────────────────────────────
// Single query each, returning a Map keyed by the input id. Dashboard /
// list pages call these once per page-load to render an N-row table
// without firing N+1 queries.

/**
 * Aggregate `{ total }` per canvas for the requested window, in one
 * query. Canvases with zero events are still represented in the
 * returned Map (`total = 0`) so list-page callers don't have to
 * post-process for missing ids.
 */
export async function getCanvasRenderUsageBatch(
	canvasIds: string[],
	opts?: DateRangeOpts,
	client: RenderEventDb = defaultDb
): Promise<Map<string, { total: number }>> {
	const result = new Map<string, { total: number }>();
	if (canvasIds.length === 0) return result;
	const { from, to } = resolveDateRange(opts);
	const rows = await client.execute<{ canvas_id: string; total: string | number }>(sql`
		SELECT
			canvas_id,
			COUNT(*)::int AS total
		FROM render_events
		WHERE canvas_id = ANY(${canvasIds}::uuid[])
			AND created_at >= ${from}
			AND created_at < ${to}
		GROUP BY canvas_id
	`);
	for (const id of canvasIds) result.set(id, { total: 0 });
	for (const r of rows) result.set(r.canvas_id, { total: Number(r.total) });
	return result;
}

/**
 * Aggregate `{ total, last429At, lastErrorAt }` per API key for the
 * requested window, in one query. Keyed by api key id; absent keys get
 * a zero-row entry so the list page can render every row uniformly.
 */
export async function getApiKeyRenderUsageBatch(
	keyIds: string[],
	opts?: DateRangeOpts,
	client: RenderEventDb = defaultDb
): Promise<Map<string, { total: number; last429At: string | null; lastErrorAt: string | null }>> {
	const result = new Map<
		string,
		{ total: number; last429At: string | null; lastErrorAt: string | null }
	>();
	if (keyIds.length === 0) return result;
	const { from, to } = resolveDateRange(opts);
	const rows = await client.execute<{
		api_key_id: string;
		total: string | number;
		last429: Date | string | null;
		last_error: Date | string | null;
	}>(sql`
		SELECT
			api_key_id,
			COUNT(*)::int AS total,
			MAX(created_at) FILTER (WHERE status_code = 429) AS last429,
			MAX(created_at) FILTER (WHERE status_code >= 500) AS last_error
		FROM render_events
		WHERE api_key_id = ANY(${keyIds}::uuid[])
			AND created_at >= ${from}
			AND created_at < ${to}
		GROUP BY api_key_id
	`);
	for (const id of keyIds) result.set(id, { total: 0, last429At: null, lastErrorAt: null });
	for (const r of rows) {
		result.set(r.api_key_id, {
			total: Number(r.total),
			last429At: r.last429 ? new Date(r.last429).toISOString() : null,
			lastErrorAt: r.last_error ? new Date(r.last_error).toISOString() : null
		});
	}
	return result;
}

// ─── Write side ──────────────────────────────────────────────────────────────

// Read the salt once at module load so the "no salt configured" warning
// fires exactly once per process — not per event, not per call site. The
// salt itself is captured in a closure-scoped constant so the query
// helpers above don't even appear to touch env (per the TASK-191
// acceptance: only `recordRenderEvent` reads env).
const IP_SALT: string | null = (() => {
	const raw = env.RENDER_EVENTS_IP_SALT?.trim();
	if (!raw) {
		console.warn(
			'[render-events] RENDER_EVENTS_IP_SALT is not set — ip_hash will be null for every event. Set the env var to enable per-day IP correlation for abuse detection.'
		);
		return null;
	}
	return raw;
})();

/**
 * Append one render-event row. Fire-and-forget: every exception is
 * logged and swallowed so an observability outage can't break the
 * render response path. Callers may `await` for tests, or `void` it in
 * hot paths — the contract is identical.
 */
export async function recordRenderEvent(
	input: RenderEventInput,
	client: RenderEventDb = defaultDb
): Promise<void> {
	try {
		const ipHash = computeIpHash(input.ip ?? null, IP_SALT);
		await client.insert(renderEvents).values({
			source: input.source,
			canvasId: input.canvasId ?? null,
			ownerUserId: input.ownerUserId ?? null,
			requesterUserId: input.requesterUserId ?? null,
			apiKeyId: input.apiKeyId ?? null,
			format: input.format,
			paramsHash: input.paramsHash,
			cacheHit: input.cacheHit,
			durationMs: input.durationMs,
			statusCode: input.statusCode,
			ipHash
		});
	} catch (err) {
		console.warn('[render-events] failed to record render event', err);
	}
}
