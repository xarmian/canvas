import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { resolveContentVersion } from '$lib/server/content-version';
import type { FabricCanvasJson } from '$lib/engine';

/**
 * GET /api/canvas/[id]/version — returns the public render route's
 * current `_v` token for this canvas, so the embed-code modal can
 * emit immutable-cache URLs.
 *
 * The token is derived from canvas.updatedAt + the user's font-set
 * fingerprint + the canvas's asset-set fingerprint (TASK-117) — same
 * algorithm as src/routes/c/[slug]/[file]/+server.ts and the share
 * page. Keeping the derivation server-side via `resolveContentVersion`
 * ensures all three call sites stay in lockstep.
 *
 * Owner-only (we don't expose this for arbitrary slugs) so a third
 * party can't trivially probe internal fingerprint state.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, params.id), eq(canvases.userId, locals.user.id)));

	if (!canvas) error(404, 'Canvas not found');

	const token = await resolveContentVersion(
		canvas.updatedAt,
		canvas.userId,
		(canvas.templateJson as unknown as FabricCanvasJson | null) ?? null
	);
	const updatedAtMs = canvas.updatedAt.getTime().toString();

	return json({ token, updatedAtMs });
};
