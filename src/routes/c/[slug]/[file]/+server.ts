import { error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases, canvasParams } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { render } from '$lib/engine';
import type { CanvasTemplate, FabricCanvasJson, OutputFormat } from '$lib/engine';
import { validateParams } from '$lib/server/canvas-params';
import { getDefaultRenderCache } from '$lib/server/render-cache';
import { ensureUserFontsRegistered, getLiveUserFontDescriptors } from '$lib/server/user-fonts';
import {
	buildContentVersionToken,
	fontSetVersionFromDescriptors
} from '$lib/server/content-version';
import { resolveAssetReferences } from '$lib/server/asset-resolver';
import {
	acquireRenderSlot,
	checkRateLimit,
	getClientIp,
	RenderBusyError,
	RENDER_THROTTLE_CONFIG
} from '$lib/server/render-throttle';

const renderCache = getDefaultRenderCache();

/** Parse output format from filename */
function parseFormat(file: string): { format: OutputFormat; contentType: string } | null {
	if (file === 'image.png') return { format: 'png', contentType: 'image/png' };
	if (file === 'image.jpg' || file === 'image.jpeg')
		return { format: 'jpeg', contentType: 'image/jpeg' };
	if (file === 'image.webp') return { format: 'webp', contentType: 'image/webp' };
	if (file === 'image.avif') return { format: 'avif', contentType: 'image/avif' };
	return null;
}

/** Parse `?_dpr=` into a clamped integer in [1,3]. Defaults to 1 (the
 *  legacy single-resolution render). Anything outside [1,3] or non-
 *  numeric falls back to 1 so a malformed URL doesn't 400 — the cap
 *  also guards against accidental ?_dpr=10 DoS via memory pressure.
 *
 *  Underscore-prefixed (like `_v`) so a user-defined canvas param
 *  named `dpr` (e.g. some statistic shown in the design) can still be
 *  bound and forwarded to the renderer without colliding with our
 *  retina-output flag. */
function parseDpr(raw: string | null): number {
	if (!raw) return 1;
	const n = Number(raw);
	if (!Number.isFinite(n)) return 1;
	const clamped = Math.max(1, Math.min(3, Math.floor(n)));
	return clamped;
}

/** Replace any user-namespaced fontFamily that's no longer in the live
 *  asset set with 'Inter'. User-namespaced families are recognizable by
 *  the `u-` prefix that scopedFontFamily emits; bundled families
 *  ("Inter", "Arial", ...) are preserved as-is. */
function sanitizeFontFamilies(json: FabricCanvasJson, liveFamilies: Set<string>): FabricCanvasJson {
	const objects = (json.objects ?? []).map((obj) => {
		const family = (obj as { fontFamily?: string }).fontFamily;
		if (typeof family === 'string' && family.startsWith('u-') && !liveFamilies.has(family)) {
			return { ...obj, fontFamily: 'Inter' };
		}
		return obj;
	});
	return { ...json, objects };
}

/** Build a cache key from slug + content version + params + format +
 * the canvas owner's font-library fingerprint.
 *
 * Why fontSetVersion is part of the key: GlobalFonts has no unregister
 * API, so a deleted font keeps rendering from the in-process registry
 * until restart — and if a render with the deleted font was cached,
 * the cache would keep serving that output even after we sanitize
 * unknown families on miss. Mixing the live-family fingerprint into
 * the key means add/delete of any font for the user busts every
 * cached render for that user's canvases. The fingerprint is the
 * sorted family list joined with '|'; small enough to not bloat the
 * key, and deterministic.
 *
 * Param serialization uses JSON so a key/value containing literal `&`
 * or `=` (e.g. `?q=1%26x=2`) can't collide with a different request
 * whose decoded params happen to look identical when joined with `&`. */
function cacheKey(
	slug: string,
	version: string,
	params: Record<string, string>,
	format: string,
	fontSetVersion: string,
	dpr: number
): string {
	const sortedEntries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
	const serializedParams = JSON.stringify(sortedEntries);
	// dpr is part of the key — `?dpr=2` and `?dpr=3` produce different
	// pixel data and must NOT collide with the dpr=1 cache entry.
	return `${slug}:${version}:${format}:fonts=${fontSetVersion}:dpr=${dpr}:${serializedParams}`;
}

/**
 * Build a strong ETag from the cache key (which already encapsulates
 * canvas updatedAt + params + format + font fingerprint). SHA-256
 * truncated to 16 hex chars is plenty for the ETag — collisions across
 * a single canvas's renders are vanishingly unlikely, and shorter
 * tags reduce header bloat at high QPS.
 */
function buildEtag(cacheKey: string): string {
	return `"${createHash('sha256').update(cacheKey).digest('hex').slice(0, 16)}"`;
}

/**
 * Per RFC 9110 §13.1.2, If-None-Match accepts:
 *   - `*` matching any current representation
 *   - a comma-separated list of entity-tags (each `"..."` or `W/"..."`)
 * Comparison is weak — strip an optional `W/` prefix from each tag
 * before comparing to our (strong) tag.
 *
 * Returns true when the request's If-None-Match indicates the cached
 * representation is still valid for our `etag`.
 */
function ifNoneMatchHits(headerValue: string, etag: string): boolean {
	const trimmed = headerValue.trim();
	if (trimmed === '*') return true;
	for (const raw of trimmed.split(',')) {
		const t = raw.trim();
		if (!t) continue;
		const stripped = t.startsWith('W/') ? t.slice(2) : t;
		if (stripped === etag) return true;
	}
	return false;
}

/**
 * Pick the right Cache-Control based on whether the request supplied
 * an `?_v=...` matching the current version token (canvas updatedAt
 * + font set fingerprint).
 *
 * - Match: the URL is fully content-versioned — a canvas edit OR a
 *   font upload/delete produces a new token. Safe to mark
 *   `immutable, max-age=1y`. Embed-code snippets (TASK-69) emit URLs
 *   in this shape so consumers get true CDN-layer immutable caching.
 * - No `_v` or stale `_v`: keep the existing short window so a canvas
 *   edit is reflected within ~5 minutes for naive consumers that paste
 *   the bare /c/<slug>/image.png URL.
 */
function pickCacheControl(requestedVersion: string | null, currentVersionToken: string): string {
	if (requestedVersion && requestedVersion === currentVersionToken) {
		return 'public, max-age=31536000, immutable';
	}
	return 'public, max-age=60, s-maxage=300';
}

export const GET: RequestHandler = async ({ params, url, request, getClientAddress }) => {
	// Parse format from filename
	const formatInfo = parseFormat(params.file);
	if (!formatInfo) {
		error(404, 'Not found. Use image.png, image.jpg, image.webp, or image.avif');
	}

	// Load canvas by slug (must be published)
	const [canvas] = await db.select().from(canvases).where(eq(canvases.slug, params.slug));

	if (!canvas || !canvas.published) {
		error(404, 'Canvas not found or not published');
	}

	// Parse URL query parameters. `_v` is reserved for the content-
	// version hint and is not forwarded to the renderer. `_v` is chosen
	// over `v` because users frequently bind short single-letter param
	// names; the underscore prefix is namespace-style and unlikely to
	// collide with a real render param.
	const queryParams: Record<string, string> = {};
	let requestedVersion: string | null = null;
	let dprParam: string | null = null;
	for (const [key, value] of url.searchParams) {
		if (key === '_v') {
			requestedVersion = value;
			continue;
		}
		if (key === '_dpr') {
			dprParam = value;
			continue;
		}
		queryParams[key] = value;
	}
	const dpr = parseDpr(dprParam);

	// Validation runs BEFORE cache lookup so a previously-cached URL
	// can't bypass newly-enforced required/type constraints. (The
	// schema rows are read on every request anyway; we'd just be
	// trading a Postgres roundtrip for a stale cache hit.)
	const paramDefs = await db
		.select()
		.from(canvasParams)
		.where(eq(canvasParams.canvasId, canvas.id));

	const validation = validateParams(queryParams, paramDefs);
	if (!validation.ok) {
		// Return a structured JSON 400 — this surface is consumed by API
		// integrators, not browsers. error() would emit text/HTML.
		return new Response(
			JSON.stringify({
				error: 'invalid_param',
				field: validation.field,
				message: validation.reason
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}
	Object.assign(queryParams, validation.resolved);

	// Compute the live font set BEFORE cache lookup. The cache key
	// includes a fingerprint of the user's current font library so any
	// add/delete of any font busts every cached render for that user.
	// Critically, the fingerprint is built from asset IDs (not just
	// family names) so delete-then-reupload of the same filename also
	// busts the cache — re-uploading produces a new asset row with a
	// new UUID even though the derived family is identical.
	const liveDescriptors = await getLiveUserFontDescriptors(canvas.userId);
	const liveFamilies = new Set(liveDescriptors.map((d) => d.family));
	const fontSetVersion = fontSetVersionFromDescriptors(liveDescriptors);

	// Cache key uses the resolved params (post-default), so two requests
	// that differ only by relying-on-default vs explicit value hit the
	// same cache entry — and a now-required param that was previously
	// cached as missing won't serve from cache (the validation above
	// already returned 400).
	// Include canvas.updatedAt so any edit (templateJson, dimensions,
	// background, even canvasParams flag changes that wouldn't change
	// the rendered bytes but might change validation behavior) busts
	// the cache. updatedAt is auto-refreshed on every PATCH via Drizzle
	// $onUpdate.
	const version = canvas.updatedAt.toISOString();
	const key = cacheKey(params.slug, version, queryParams, formatInfo.format, fontSetVersion, dpr);
	const etag = buildEtag(key);
	const updatedAtMs = canvas.updatedAt.getTime().toString();
	const lastModified = canvas.updatedAt.toUTCString();
	const versionToken = buildContentVersionToken(updatedAtMs, fontSetVersion);
	const cacheControl = pickCacheControl(requestedVersion, versionToken);

	// Conditional GET: 304 short-circuits before we touch storage / cache.
	// Per RFC 9110: when If-None-Match is present the recipient MUST
	// ignore If-Modified-Since. Without that ordering, a canvas edited
	// within the same wall-second as a previous fetch would: send a new
	// ETag (cache miss) but the second-rounded Last-Modified would
	// still match If-Modified-Since → false 304 → consumer keeps the
	// stale render.
	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch !== null) {
		if (ifNoneMatchHits(ifNoneMatch, etag)) {
			return new Response(null, {
				status: 304,
				headers: {
					ETag: etag,
					'Cache-Control': cacheControl,
					'Last-Modified': lastModified,
					Vary: 'Accept'
				}
			});
		}
		// ETag didn't match — fall through to a full render. Skip the
		// If-Modified-Since branch entirely per RFC 9110.
	}
	// Note: we deliberately do NOT honor If-Modified-Since 304s. The
	// rendered bytes depend on the canvas owner's font library too, and
	// font upload/delete doesn't bump canvas.updatedAt. A client validating
	// purely with If-Modified-Since after a font change would get a false
	// 304. ETag (which includes the font fingerprint) is the strong
	// validator — clients that send both headers are well-served by the
	// If-None-Match branch above. Last-Modified is still emitted so HTTP
	// archivers and explorer tools can show a timestamp.

	const cachedBuf = await renderCache.get(key, formatInfo.format);
	if (cachedBuf) {
		return new Response(new Uint8Array(cachedBuf), {
			headers: {
				'Content-Type': formatInfo.contentType,
				'Cache-Control': cacheControl,
				ETag: etag,
				'Last-Modified': lastModified,
				Vary: 'Accept',
				'X-Cache': 'HIT'
			}
		});
	}

	// Cache miss → we're going to do real CPU work. Apply throttle layers
	// in this order: per-IP rate limit first (cheap, fails fast), then the
	// process-wide concurrency semaphore (waits up to QUEUE_TIMEOUT_MS for
	// a slot). Both are intentionally bypassed on cache hit above so a hot
	// URL can absorb burst traffic without burning rate budget.
	const ip = getClientIp(request.headers, getClientAddress());
	const limit = checkRateLimit(ip);
	if (!limit.allowed) {
		console.warn(
			`[render] rate-limited ip=${ip} slug=${params.slug} retryAfter=${limit.retryAfterSeconds}s`
		);
		return new Response('Too Many Requests', {
			status: 429,
			headers: {
				'Retry-After': String(limit.retryAfterSeconds),
				'X-RateLimit-Limit': String(limit.limit),
				'X-RateLimit-Remaining': '0'
			}
		});
	}

	let releaseSlot: () => void;
	try {
		releaseSlot = await acquireRenderSlot();
	} catch (err) {
		if (err instanceof RenderBusyError) {
			console.warn(
				`[render] queue-timeout ip=${ip} slug=${params.slug} concurrency=${RENDER_THROTTLE_CONFIG.concurrency}`
			);
			return new Response('Service Unavailable', {
				status: 503,
				headers: {
					'Retry-After': String(err.retryAfterSeconds),
					'X-RateLimit-Limit': String(limit.limit),
					'X-RateLimit-Remaining': String(limit.remaining)
				}
			});
		}
		throw err;
	}

	try {
		// Register the canvas owner's uploaded fonts before rendering. No-op
		// after the first render in this process unless new fonts have been
		// uploaded since. Failure is logged inside ensureUserFontsRegistered
		// and is non-fatal — the renderer will fall back to the default
		// font set instead of 500-ing the public render URL.
		await ensureUserFontsRegistered(canvas.userId);

		// Sanitize fontFamily references that point at deleted fonts.
		// GlobalFonts has no unregister API — once a font has been
		// registered in this process, it stays in Skia's table. Without the
		// swap, a canvas whose author deleted the asset would keep
		// rendering with the deleted bytes until the server restarted.
		// Cache freshness is handled by the fontSetVersion in the key above.
		const sanitizedJson = sanitizeFontFamilies(
			(canvas.templateJson as unknown as FabricCanvasJson) ?? { objects: [] },
			liveFamilies
		);

		// Resolve `asset://{id}` references to their storage URLs (TASK-89).
		// Owner-scoped — cross-user refs and deleted IDs are silently
		// dropped to the placeholder path inside the renderer's image
		// fetcher, never 500s. Returns a URL→Buffer preload map for
		// owned assets so the renderer doesn't need to round-trip
		// through HTTP (and skips the SSRF check that would block
		// local-storage / private-host URLs).
		const preloadedImages = await resolveAssetReferences(sanitizedJson, canvas.userId);

		const template: CanvasTemplate = {
			width: canvas.width,
			height: canvas.height,
			backgroundType: canvas.backgroundType as 'color' | 'image',
			backgroundValue: canvas.backgroundValue,
			templateJson: sanitizedJson
		};

		const buffer = await render(template, queryParams, {
			format: formatInfo.format,
			quality: 85,
			dpr,
			preloadedImages
		});

		// Persist to filesystem cache. The FsRenderCache handles LRU
		// eviction internally based on CACHE_MAX_MB.
		await renderCache.set(key, formatInfo.format, buffer);

		return new Response(new Uint8Array(buffer), {
			headers: {
				'Content-Type': formatInfo.contentType,
				'Cache-Control': cacheControl,
				ETag: etag,
				'Last-Modified': lastModified,
				Vary: 'Accept',
				'X-Cache': 'MISS',
				'X-RateLimit-Limit': String(limit.limit),
				'X-RateLimit-Remaining': String(limit.remaining)
			}
		});
	} finally {
		releaseSlot();
	}
};
