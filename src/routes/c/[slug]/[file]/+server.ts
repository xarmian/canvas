import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases, canvasParams } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { render } from '$lib/engine';
import type { CanvasTemplate, FabricCanvasJson, OutputFormat } from '$lib/engine';
import { validateParams } from '$lib/server/canvas-params';
import { getDefaultRenderCache } from '$lib/server/render-cache';
import { ensureUserFontsRegistered, getLiveUserFontFamilies } from '$lib/server/user-fonts';

const renderCache = getDefaultRenderCache();

/** Parse output format from filename */
function parseFormat(file: string): { format: OutputFormat; contentType: string } | null {
	if (file === 'image.png') return { format: 'png', contentType: 'image/png' };
	if (file === 'image.jpg' || file === 'image.jpeg')
		return { format: 'jpeg', contentType: 'image/jpeg' };
	if (file === 'image.webp') return { format: 'webp', contentType: 'image/webp' };
	return null;
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

/** Build a cache key from slug + content version + params + format.
 * Including a content version (canvas.updatedAt) is critical — without
 * it, edits to templateJson, dimensions, or background would keep
 * serving the stale render from cache until eviction. The persistent
 * cache makes that staleness window unbounded; the in-memory v0.1
 * cache had a 60s TTL papering over the same shape of bug.
 *
 * Param serialization uses JSON so a key/value containing literal `&`
 * or `=` (e.g. `?q=1%26x=2`) can't collide with a different request
 * whose decoded params happen to look identical when joined with `&`. */
function cacheKey(
	slug: string,
	version: string,
	params: Record<string, string>,
	format: string
): string {
	const sortedEntries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
	const serializedParams = JSON.stringify(sortedEntries);
	return `${slug}:${version}:${format}:${serializedParams}`;
}

export const GET: RequestHandler = async ({ params, url }) => {
	// Parse format from filename
	const formatInfo = parseFormat(params.file);
	if (!formatInfo) {
		error(404, 'Not found. Use image.png, image.jpg, or image.webp');
	}

	// Load canvas by slug (must be published)
	const [canvas] = await db.select().from(canvases).where(eq(canvases.slug, params.slug));

	if (!canvas || !canvas.published) {
		error(404, 'Canvas not found or not published');
	}

	// Parse URL query parameters
	const queryParams: Record<string, string> = {};
	for (const [key, value] of url.searchParams) {
		queryParams[key] = value;
	}

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
	const key = cacheKey(params.slug, version, queryParams, formatInfo.format);
	const cachedBuf = await renderCache.get(key, formatInfo.format);
	if (cachedBuf) {
		return new Response(new Uint8Array(cachedBuf), {
			headers: {
				'Content-Type': formatInfo.contentType,
				'Cache-Control': 'public, max-age=60, s-maxage=300',
				'X-Cache': 'HIT'
			}
		});
	}

	// Register the canvas owner's uploaded fonts before rendering. No-op
	// after the first render in this process unless new fonts have been
	// uploaded since. Failure is logged inside ensureUserFontsRegistered
	// and is non-fatal — the renderer will fall back to the default
	// font set instead of 500-ing the public render URL.
	await ensureUserFontsRegistered(canvas.userId);

	// Build template, then sanitize fontFamily references that point at
	// deleted fonts. GlobalFonts has no unregister API — once a font has
	// been registered in this process, it stays in Skia's table. So a
	// canvas whose author deleted the asset would keep rendering with
	// the deleted bytes until the server restarted. Swapping to 'Inter'
	// here gives consistent fallback behavior in-process AND across
	// restarts. The cache key already includes canvas.updatedAt, so a
	// post-delete edit busts the cache and serves the swapped output.
	const liveFamilies = await getLiveUserFontFamilies(canvas.userId);
	const sanitizedJson = sanitizeFontFamilies(
		(canvas.templateJson as unknown as FabricCanvasJson) ?? { objects: [] },
		liveFamilies
	);

	const template: CanvasTemplate = {
		width: canvas.width,
		height: canvas.height,
		backgroundType: canvas.backgroundType as 'color' | 'image',
		backgroundValue: canvas.backgroundValue,
		templateJson: sanitizedJson
	};

	// Render
	const buffer = await render(template, queryParams, {
		format: formatInfo.format,
		quality: 85
	});

	// Persist to filesystem cache. The FsRenderCache handles LRU
	// eviction internally based on CACHE_MAX_MB.
	await renderCache.set(key, formatInfo.format, buffer);

	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': formatInfo.contentType,
			'Cache-Control': 'public, max-age=60, s-maxage=300',
			'X-Cache': 'MISS'
		}
	});
};
