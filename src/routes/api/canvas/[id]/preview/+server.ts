import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { render } from '$lib/engine';
import type { CanvasTemplate, FabricCanvasJson } from '$lib/engine';
import { ensureUserFontsRegistered, getLiveUserFontFamilies } from '$lib/server/user-fonts';
import { resolveAssetReferences } from '$lib/server/asset-resolver';

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

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, params.id), eq(canvases.userId, locals.user.id)));

	if (!canvas) error(404, 'Canvas not found');

	// Forward non-reserved query parameters to the renderer so the editor's
	// Test Parameters panel can drive a live parameterized preview without
	// requiring the canvas to be published.
	const previewParams: Record<string, string> = {};
	for (const [key, value] of url.searchParams) {
		if (RESERVED_QUERY_KEYS.has(key)) continue;
		previewParams[key] = value;
	}

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
		format: 'png',
		quality: 85,
		preloadedImages
	});

	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'no-cache'
		}
	});
};
