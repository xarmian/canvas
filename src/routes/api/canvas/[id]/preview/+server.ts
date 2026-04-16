import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { render } from '$lib/engine';
import type { CanvasTemplate, FabricCanvasJson } from '$lib/engine';

/**
 * Authenticated preview endpoint — renders a canvas image for the owner
 * without requiring it to be published. Used by the editor preview button.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, params.id), eq(canvases.userId, locals.user.id)));

	if (!canvas) error(404, 'Canvas not found');

	const template: CanvasTemplate = {
		width: canvas.width,
		height: canvas.height,
		backgroundType: canvas.backgroundType as 'color' | 'image',
		backgroundValue: canvas.backgroundValue,
		templateJson: (canvas.templateJson as unknown as FabricCanvasJson) ?? { objects: [] }
	};

	const buffer = await render(template, {}, { format: 'png', quality: 85 });

	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'no-cache'
		}
	});
};
