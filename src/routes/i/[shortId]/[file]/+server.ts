/**
 * GET /i/{shortId}/image.{ext} — app-proxied bytes for a baked render.
 *
 * Per IDEA-161 Q3 storage (MinIO / S3) is never exposed publicly;
 * every byte goes through the SvelteKit server so a misplaced bucket
 * ACL can't accidentally make user content directly reachable. Cache
 * headers are immutable because the shortId is the content address —
 * dedup guarantees same inputs → same shortId, different inputs →
 * different shortId, and the bytes for a given shortId never change.
 *
 * Co-ordinated with TASK-170 (the share page references this URL in
 * its OG meta and image preview). Lands together so social crawlers
 * never see a 404 for a freshly-created `/i/{shortId}` page.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { renderedImages } from '$lib/server/db/schema';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';

const FORMAT_MIME: Record<string, string> = {
	png: 'image/png',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	avif: 'image/avif'
};

const SHORT_ID_RE = /^[A-Za-z0-9_-]{10}$/;

/** Map a requested URL-extension to the canonical format token stored
 *  on the row. Accepts `image.jpg` as an alias for `image.jpeg`. */
function parseFile(file: string): string | null {
	const m = /^image\.(png|jpe?g|webp|avif)$/.exec(file);
	if (!m) return null;
	return m[1] === 'jpg' ? 'jpeg' : m[1];
}

/** Match an `If-None-Match` header value against our strong tag.
 *  Browsers occasionally send `"tag1", "tag2"` lists; comma-split and
 *  trim before comparison so a list still hits a 304 for any of the
 *  listed tags. Doesn't accept `W/` (weak) prefix because the bytes are
 *  content-addressed — there's no weak-equality regime to fall back on. */
function ifNoneMatchHits(headerValue: string, etag: string): boolean {
	const trimmed = headerValue.trim();
	if (trimmed === '*') return true;
	for (const raw of trimmed.split(',')) {
		if (raw.trim() === etag) return true;
	}
	return false;
}

export const GET: RequestHandler = async ({ params, request }) => {
	if (!SHORT_ID_RE.test(params.shortId)) error(404, 'Not found');

	const requestedFormat = parseFile(params.file);
	if (!requestedFormat) error(404, 'Not found');

	const [row] = await db
		.select({
			id: renderedImages.id,
			format: renderedImages.format,
			storageKey: renderedImages.storageKey,
			shortId: renderedImages.shortId
		})
		.from(renderedImages)
		.where(
			and(
				eq(renderedImages.shortId, params.shortId),
				isNull(renderedImages.deletedAt),
				or(isNull(renderedImages.expiresAt), gt(renderedImages.expiresAt, new Date()))
			)
		)
		.limit(1);
	if (!row) error(404, 'Not found');

	// Baked renders are immutable artifacts — no on-the-fly transcoding.
	// A request for `/image.png` against a webp-baked row 404s rather than
	// re-encoding. Integrators that want JPEG vs WebP should POST twice
	// with different `format`s.
	if (row.format !== requestedFormat) error(404, 'Not found');

	// ETag is the shortId itself — content-addressed by construction.
	// Strong validator; safe to mark `immutable` for the whole 1-year
	// window. The matching 304 path doesn't hit storage.
	const etag = `"${row.shortId}"`;
	const cacheControl = 'public, max-age=31536000, immutable';

	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch !== null && ifNoneMatchHits(ifNoneMatch, etag)) {
		return new Response(null, {
			status: 304,
			headers: {
				ETag: etag,
				'Cache-Control': cacheControl
			}
		});
	}

	let bytes: Buffer;
	try {
		bytes = await getStorage().read(row.storageKey);
	} catch (err) {
		// Row exists but the blob doesn't — storage was deleted under us,
		// or the upload silently failed at create time. Either way log
		// and 404 (the row is still useful as a placeholder for the
		// sweep CLI to reap).
		console.error(
			`[i/${row.shortId}] storage miss key=${row.storageKey}`,
			err instanceof Error ? err.message : err
		);
		error(404, 'Not found');
	}

	// Fire-and-forget lastAccessedAt bump. Mirrors the share-page load —
	// every byte fetch counts as activity for retention bookkeeping.
	const rowId = row.id;
	setImmediate(() => {
		db.update(renderedImages)
			.set({ lastAccessedAt: new Date() })
			.where(eq(renderedImages.id, rowId))
			.catch((err) => {
				console.warn(`[i/${row.shortId}] lastAccessedAt bump failed`, err);
			});
	});

	return new Response(new Uint8Array(bytes), {
		headers: {
			'Content-Type': FORMAT_MIME[row.format] ?? 'application/octet-stream',
			'Cache-Control': cacheControl,
			ETag: etag,
			Vary: 'Accept'
		}
	});
};
