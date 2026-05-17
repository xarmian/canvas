import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { render } from '$lib/engine';
import type { CanvasTemplate, FabricCanvasJson } from '$lib/engine';
import { ensureUserFontsRegistered, getLiveUserFontFamilies } from '$lib/server/user-fonts';
import { resolveAssetReferences } from '$lib/server/asset-resolver';
import { getClientIp } from '$lib/server/render-throttle';
import { recordRenderEvent } from '$lib/server/render-events';

/** Match the public render route's sanitizer — kept inline (not
 *  exported) so the two endpoints don't accidentally drift. */
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

/**
 * Authenticated preview endpoint — renders a canvas image for the owner
 * without requiring it to be published. Used by the editor preview button.
 */
/** Reserved query keys handled by the editor (cache-buster etc.); stripped
 * before the remainder is forwarded to the renderer as binding values. */
const RESERVED_QUERY_KEYS = new Set(['_t']);

/** Preview format is fixed today (always PNG). Captured as a constant so
 *  the analytics event below uses the same source as the actual render. */
const PREVIEW_FORMAT = 'png';

/**
 * Marker `paramsHash` used when an event fires before the params have
 * been canonicalized — i.e. a 401/404 thrown before we reach the
 * deterministic JSON encoding. The schema's `params_hash` column is
 * NOT NULL; the value is intentionally non-hex so analytics queries
 * can recognize "early failure" rows without joining anywhere.
 */
const EARLY_FAILURE_PARAMS_HASH = 'pre-hash';

/**
 * Build the analytics-only `params_hash` for a preview event. We hash
 * the same inputs the renderer actually reads — canvas id, sorted
 * params, format — rather than reusing `buildContentHashInputs` from
 * the baked-render path. Preview has no semantic cache (it always
 * renders fresh), so the heavier font/asset/canvas-version fingerprints
 * the baked path needs for dedup correctness would just add latency
 * to every preview without buying anything.
 */
function buildPreviewParamsHash(args: {
	canvasId: string;
	params: Record<string, string>;
	format: string;
}): string {
	const sortedEntries = Object.entries(args.params).sort(([a], [b]) => a.localeCompare(b));
	const canonical = JSON.stringify({
		c: args.canvasId,
		p: sortedEntries,
		f: args.format
	});
	return createHash('sha256').update(canonical).digest('hex');
}

export const GET: RequestHandler = async ({ params, url, locals, request, getClientAddress }) => {
	// Same accumulator pattern as POST /api/v1/renders: populate as the
	// handler progresses, fire the event in `finally` so every code path
	// (401/404/render-failure/200) lands one `render_events` row.
	// `cache_hit` is always false for preview — the editor explicitly
	// wants a fresh render every time the Preview button fires.
	const startedAt = Date.now();
	const event = {
		source: 'preview' as const,
		canvasId: null as string | null,
		ownerUserId: null as string | null,
		requesterUserId: locals.user?.id ?? null,
		apiKeyId: null as string | null,
		format: PREVIEW_FORMAT,
		paramsHash: EARLY_FAILURE_PARAMS_HASH,
		cacheHit: false,
		statusCode: 500
	};
	try {
		if (!locals.user) error(401, 'Unauthorized');

		const [canvas] = await db
			.select()
			.from(canvases)
			.where(and(eq(canvases.id, params.id), eq(canvases.userId, locals.user.id)));

		if (!canvas) error(404, 'Canvas not found');
		event.canvasId = canvas.id;
		event.ownerUserId = canvas.userId;

		// Forward non-reserved query parameters to the renderer so the editor's
		// Test Parameters panel can drive a live parameterized preview without
		// requiring the canvas to be published.
		const previewParams: Record<string, string> = {};
		for (const [key, value] of url.searchParams) {
			if (RESERVED_QUERY_KEYS.has(key)) continue;
			previewParams[key] = value;
		}
		event.paramsHash = buildPreviewParamsHash({
			canvasId: canvas.id,
			params: previewParams,
			format: PREVIEW_FORMAT
		});

		// Mirror the public render route so editor preview uses the same
		// fonts the eventually-published image will. Without this, an editor
		// preview falls back to default fonts while the published render at
		// /c/[slug]/image.png uses the uploaded family — diverging output is
		// the worst possible footgun for preview's "what will my consumers
		// see" promise.
		await ensureUserFontsRegistered(canvas.userId);

		// Mirror the public render route: sanitize fontFamily references
		// that point at deleted fonts so preview matches what the published
		// render will produce.
		const liveFamilies = await getLiveUserFontFamilies(canvas.userId);
		const sanitizedJson = sanitizeFontFamilies(
			(canvas.templateJson as unknown as FabricCanvasJson) ?? { objects: [] },
			liveFamilies
		);

		// Resolve `asset://{id}` references to their storage URLs (TASK-89).
		// Mirrors the public render route. Owner-scoped via canvas.userId
		// (which equals locals.user.id here, since the SELECT above already
		// filtered to the requesting user's canvases). Returns a URL→Buffer
		// preload map so owned assets bypass the SSRF-bounded fetch.
		const preloadedImages = await resolveAssetReferences(sanitizedJson, canvas.userId);

		const template: CanvasTemplate = {
			width: canvas.width,
			height: canvas.height,
			backgroundType: canvas.backgroundType as 'color' | 'image',
			backgroundValue: canvas.backgroundValue,
			templateJson: sanitizedJson
		};

		const buffer = await render(template, previewParams, {
			format: PREVIEW_FORMAT,
			quality: 85,
			preloadedImages
		});

		event.statusCode = 200;
		return new Response(new Uint8Array(buffer), {
			headers: {
				'Content-Type': 'image/png',
				'Cache-Control': 'no-cache'
			}
		});
	} catch (err) {
		// SvelteKit's `error()` throws an `HttpError` with a `.status` field;
		// `Response` is also thrown by other endpoints' helpers. Capture
		// whichever is present and re-throw — the response layer handles
		// rendering.
		if (err instanceof Response) {
			event.statusCode = err.status;
		} else if (
			err !== null &&
			typeof err === 'object' &&
			'status' in err &&
			typeof (err as { status: unknown }).status === 'number'
		) {
			event.statusCode = (err as { status: number }).status;
		} else {
			event.statusCode = 500;
		}
		throw err;
	} finally {
		// `getClientIp` returns the sentinel `'unknown'` when no socket
		// address is available (e.g. some test contexts); coerce to null
		// so `recordRenderEvent` stores `ip_hash=null` instead of hashing
		// the sentinel into a same-day-correlatable value.
		const rawIp = getClientIp(request.headers, getClientAddress() ?? null);
		void recordRenderEvent({
			source: event.source,
			canvasId: event.canvasId,
			ownerUserId: event.ownerUserId,
			requesterUserId: event.requesterUserId,
			apiKeyId: event.apiKeyId,
			format: event.format,
			paramsHash: event.paramsHash,
			cacheHit: event.cacheHit,
			durationMs: Date.now() - startedAt,
			statusCode: event.statusCode,
			ip: rawIp === 'unknown' ? null : rawIp
		});
	}
};
