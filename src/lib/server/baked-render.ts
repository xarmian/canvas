/**
 * Shared render pipeline for the Programmatic Render API.
 *
 * This is the same sequence as the live `/c/{slug}/image.*` route uses:
 *
 *   1. ensure the canvas owner's uploaded fonts are registered in-process
 *   2. resolve the user's live font set (used to sanitize stale family
 *      refs in the templateJson)
 *   3. swap any user-namespaced fontFamily references that no longer
 *      exist for 'Inter' (GlobalFonts has no unregister; the cache key
 *      handles freshness)
 *   4. collect + resolve `asset://{id}` references owner-scoped so the
 *      renderer can read uploaded image bytes without an HTTP roundtrip
 *   5. invoke `render()` with the assembled inputs
 *
 * TASK-168 publishes this helper but does NOT yet refactor the existing
 * `c/[slug]/[file]/+server.ts` to consume it — that's a separate cleanup
 * to avoid scope creep on this PR.
 */
import { render } from '$lib/engine';
import type { CanvasTemplate, FabricCanvasJson, OutputFormat } from '$lib/engine';
import { ensureUserFontsRegistered, getLiveUserFontDescriptors } from '$lib/server/user-fonts';
import { resolveAssetReferences } from '$lib/server/asset-resolver';

/** Minimal canvas-row shape consumed by the renderer — kept narrow so the
 *  helper doesn't need a full Drizzle row. */
export interface RenderableCanvas {
	width: number;
	height: number;
	backgroundType: string;
	backgroundValue: string;
	templateJson: unknown;
	userId: string;
}

export interface BakedRenderOptions {
	format: OutputFormat;
	/** 1..3. Defaults to 1. */
	dpr?: number;
	/** JPEG/WebP/AVIF quality 0-100; PNG ignores. Defaults to 85, matching
	 *  the live render route. */
	quality?: number;
}

export interface BakedRenderResult {
	buffer: Buffer;
	/** Pixel width of the rendered output (template width × dpr). */
	width: number;
	/** Pixel height of the rendered output. */
	height: number;
	/** Byte length of `buffer`. Convenience — equivalent to `buffer.length`. */
	sizeBytes: number;
}

/**
 * Swap any user-namespaced fontFamily (prefix `u-`) that's no longer in
 * the live family set for `Inter`. Bundled families ("Inter", "Arial", …)
 * are preserved as-is. Pure function — does not mutate the input.
 */
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
 * Render a canvas for a specific user + param set into the requested
 * format. Returns the raw bytes plus the pixel dimensions of the result.
 *
 * Throws if the underlying `render()` engine throws. Callers are
 * expected to hold a render-slot semaphore (`acquireRenderSlot`)
 * around this call — the helper deliberately does NOT acquire one
 * itself so the caller can release it in a single `finally` regardless
 * of where the error came from (validation vs render vs storage upload).
 */
export async function renderForUser(
	canvas: RenderableCanvas,
	params: Record<string, string>,
	options: BakedRenderOptions
): Promise<BakedRenderResult> {
	const dpr = Math.max(1, Math.min(3, Math.floor(options.dpr ?? 1)));
	const quality = options.quality ?? 85;

	await ensureUserFontsRegistered(canvas.userId);
	const liveDescriptors = await getLiveUserFontDescriptors(canvas.userId);
	const liveFamilies = new Set(liveDescriptors.map((d) => d.family));

	const sanitizedJson = sanitizeFontFamilies(
		((canvas.templateJson as FabricCanvasJson | null) ?? { objects: [] }) as FabricCanvasJson,
		liveFamilies
	);

	const preloadedImages = await resolveAssetReferences(sanitizedJson, canvas.userId);

	const template: CanvasTemplate = {
		width: canvas.width,
		height: canvas.height,
		backgroundType: canvas.backgroundType as 'color' | 'image',
		backgroundValue: canvas.backgroundValue,
		templateJson: sanitizedJson
	};

	const buffer = await render(template, params, {
		format: options.format,
		quality,
		dpr,
		preloadedImages
	});

	return {
		buffer,
		width: canvas.width * dpr,
		height: canvas.height * dpr,
		sizeBytes: buffer.length
	};
}

/** Format-to-MIME-and-extension mapping. Used by the POST endpoint to
 *  build the storage key + Content-Type. Exported for the upcoming
 *  `/i/{shortId}/image.{ext}` proxy route (TASK-171). */
export const FORMAT_EXTENSIONS: Record<OutputFormat, { ext: string; contentType: string }> = {
	png: { ext: 'png', contentType: 'image/png' },
	jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
	webp: { ext: 'webp', contentType: 'image/webp' },
	avif: { ext: 'avif', contentType: 'image/avif' }
};

/** Canonical content-hash inputs. Mixing `dpr` and `format` means a
 *  same-params request for a different resolution / encoding produces a
 *  distinct hash and stores its own blob, but two identical re-POSTs
 *  collapse to one row. Param order is normalized before serialization.
 *
 *  SECURITY note: callers MUST pass the *resolved* params (post-
 *  `validateParams`), not the raw request body — otherwise two requests
 *  that only differ in which keys relied on defaults would not dedup,
 *  spamming storage with identical blobs. */
export function buildContentHashInputs(args: {
	userId: string;
	canvasId: string;
	params: Record<string, string>;
	format: string;
	dpr: number;
	forwardUrl: string | null;
	ogTitle: string | null;
	ogDescription: string | null;
}): string {
	const sortedEntries = Object.entries(args.params).sort(([a], [b]) => a.localeCompare(b));
	const serializedParams = JSON.stringify(sortedEntries);
	return [
		args.userId,
		args.canvasId,
		serializedParams,
		args.format,
		String(args.dpr),
		args.forwardUrl ?? '',
		args.ogTitle ?? '',
		args.ogDescription ?? ''
	].join('|');
}
