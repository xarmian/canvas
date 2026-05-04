import { json, error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getLiveUserFontDescriptors } from '$lib/server/user-fonts';

/**
 * GET /api/canvas/[id]/version — returns the public render route's
 * current `_v` token for this canvas, so the embed-code modal can
 * emit immutable-cache URLs.
 *
 * The token is derived from canvas.updatedAt + the user's font-set
 * fingerprint (same algorithm as src/routes/c/[slug]/[file]/+server.ts).
 * Keeping the derivation server-side means clients don't need access to
 * the font asset list or the algorithm — they just paste the token into
 * the URL.
 *
 * Owner-only (we don't expose this for arbitrary slugs) so a third party
 * can't trivially probe internal fingerprint state.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, params.id), eq(canvases.userId, locals.user.id)));

	if (!canvas) error(404, 'Canvas not found');

	const liveDescriptors = await getLiveUserFontDescriptors(canvas.userId);
	const fontSetVersion = liveDescriptors
		.map((d) => d.id)
		.sort()
		.join('|');
	const updatedAtMs = canvas.updatedAt.getTime().toString();
	const token = createHash('sha256')
		.update(`${updatedAtMs}|${fontSetVersion}`)
		.digest('hex')
		.slice(0, 12);

	return json({ token, updatedAtMs });
};
