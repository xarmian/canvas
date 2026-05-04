import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases, canvasParams } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * Read the per-canvas parameter schema (TASK-52). Owners only — schema
 * is private to the canvas's editor surface; the public render endpoint
 * loads it directly from the DB rather than going through this route.
 *
 * Schema rows are auto-derived from templateJson on save (see
 * canvas-params.ts:syncCanvasParams). User-editable flags (`required`,
 * `type`) are persisted on PATCH /api/canvas/[id] with { params: [...] }.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, params.id), eq(canvases.userId, locals.user.id)));
	if (!canvas) error(404, 'Canvas not found');

	const rows = await db.select().from(canvasParams).where(eq(canvasParams.canvasId, canvas.id));
	return json(rows);
};
