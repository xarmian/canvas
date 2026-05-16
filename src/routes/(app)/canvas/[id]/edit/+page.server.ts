import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCanvasRenderUsage } from '$lib/server/render-events';

export const load: PageServerLoad = async ({ params, locals }) => {
	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, params.id), eq(canvases.userId, locals.user!.id)));

	if (!canvas) {
		error(404, 'Canvas not found');
	}

	// Per-canvas usage total for the editor-header badge (TASK-196).
	// Uses the same 30-day default window as the dashboard card and the
	// /account/usage tile so the three numbers always agree for a given
	// canvas.
	const usage = await getCanvasRenderUsage(canvas.id);

	return { canvas, renderCount: usage.total };
};
