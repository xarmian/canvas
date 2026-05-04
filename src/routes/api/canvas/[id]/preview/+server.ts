import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { render } from '$lib/engine';
import type { CanvasTemplate, FabricCanvasJson } from '$lib/engine';
import { ensureUserFontsRegistered } from '$lib/server/user-fonts';

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

	const template: CanvasTemplate = {
		width: canvas.width,
		height: canvas.height,
		backgroundType: canvas.backgroundType as 'color' | 'image',
		backgroundValue: canvas.backgroundValue,
		templateJson: (canvas.templateJson as unknown as FabricCanvasJson) ?? { objects: [] }
	};

	const buffer = await render(template, previewParams, { format: 'png', quality: 85 });

	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'no-cache'
		}
	});
};
