import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { eq, and, desc, sql, like } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';

/** Hard cap on a single page so a request can't pull a user's full library
 *  in one round-trip and bog down the dashboard. The /assets page uses
 *  ?offset= for paging through. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * GET /api/library — list the current user's image assets, newest first.
 * Used by both the /assets browse page and the editor's "From library" tab.
 *
 * Query params:
 *   - limit  (1..100, default 50)
 *   - offset (>=0, default 0)
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

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

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
	if (raw === null) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}
