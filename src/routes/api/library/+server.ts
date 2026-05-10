import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { eq, and, desc, sql, like, inArray } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';

/** Hard cap on a single page so a request can't pull a user's full library
 *  in one round-trip and bog down the dashboard. The /assets page uses
 *  ?offset= for paging through. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/** Cap on a single batched ID lookup. The editor opens canvases that
 *  reference at most a handful of unique assets in practice; bounding
 *  the array keeps a hand-crafted URL from sending the DB an oversized
 *  `inArray(...)` predicate. */
const MAX_LOOKUP_IDS = 100;

/** Match RFC 4122 canonical form. Mirrors the resolver — malformed values
 *  must not reach `inArray(assets.id, ...)` against a uuid column or the
 *  query throws. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/library — list the current user's image assets, newest first.
 * Used by both the /assets browse page and the editor's "From library" tab.
 *
 * Query params:
 *   - `ids=uuid1,uuid2,...` — batch lookup mode (TASK-116). Returns only
 *     the rows whose ids are in the set AND that the caller owns. Ignores
 *     limit/offset. Used by the editor to translate `asset://{id}` refs
 *     into public URLs at canvas-load time.
 *   - `limit`  (1..100, default 50) — list mode
 *   - `offset` (>=0, default 0)     — list mode
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const idsParam = url.searchParams.get('ids');
	if (idsParam !== null) {
		return handleLookup(idsParam, locals.user.id);
	}

	const limit = clampInt(url.searchParams.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT);
	const offset = clampInt(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);

	// Filter to image content-types only — fonts also live in `assets` but
	// are managed via TASK-63's font picker, not the image library UI.
	const imageContentType = like(assets.contentType, 'image/%');

	const rows = await db
		.select()
		.from(assets)
		.where(and(eq(assets.userId, locals.user.id), imageContentType))
		.orderBy(desc(assets.createdAt))
		.limit(limit)
		.offset(offset);

	const [{ total }] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(assets)
		.where(and(eq(assets.userId, locals.user.id), imageContentType));

	const storage = getStorage();
	const items = rows.map((a) => ({
		id: a.id,
		filename: a.filename,
		url: storage.getUrl(a.storageKey),
		contentType: a.contentType,
		sizeBytes: a.sizeBytes,
		createdAt: a.createdAt
	}));

	return json({ items, total, limit, offset });
};

/**
 * Batched ID lookup for the editor's `asset://` resolver. Returns the
 * caller's owned image rows whose ids match the input set. Cross-user
 * ids and malformed UUIDs are silently dropped (same model as the
 * server-side `asset-resolver`): a missing id falls through to the
 * renderer's placeholder path.
 */
async function handleLookup(idsParam: string, userId: string) {
	const requested = idsParam
		.split(',')
		.map((s) => s.trim())
		.filter((s) => UUID_RE.test(s));
	if (requested.length === 0) return json({ items: [] });
	if (requested.length > MAX_LOOKUP_IDS) error(400, 'Too many ids');

	// Image-only filter so a font asset can't be looked up by guessing
	// its id through this endpoint — keeps the editor library API
	// scope-consistent with the list mode.
	const rows = await db
		.select()
		.from(assets)
		.where(
			and(
				inArray(assets.id, requested),
				eq(assets.userId, userId),
				like(assets.contentType, 'image/%')
			)
		);

	const storage = getStorage();
	const items = rows.map((a) => ({
		id: a.id,
		filename: a.filename,
		url: storage.getUrl(a.storageKey),
		contentType: a.contentType,
		sizeBytes: a.sizeBytes,
		createdAt: a.createdAt
	}));
	return json({ items });
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
	if (raw === null) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}
