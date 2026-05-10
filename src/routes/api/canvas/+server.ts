import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';
import { findAvailableSlug, slugify } from '$lib/server/slug';

/** List all canvases for the authenticated user */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const userCanvases = await db
		.select()
		.from(canvases)
		.where(eq(canvases.userId, locals.user.id))
		.orderBy(desc(canvases.updatedAt));

	return json(userCanvases);
};

/** Create a new canvas. Optional templateJson lets starter-template flows
 * seed a pre-built canvas; otherwise a blank one is created.
 *
 * Slug derivation (TASK-92): the v1 URL scheme is `/c/{slug}` with
 * globally-unique user-chosen slugs. We auto-derive the initial slug
 * from the canvas name and resolve collisions by appending the smallest
 * `-N` suffix that's free. Users can rename later via PATCH (TASK-98)
 * with explicit collision feedback. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const body = await request.json();
	const { name, width, height, backgroundType, backgroundValue, templateJson } = body;

	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		error(400, 'Canvas name is required');
	}

	// Minimal shape check on templateJson — we store it as JSONB, but anything
	// other than a plain object with an `objects` array will break the renderer.
	let safeTemplate: { version: string; objects: unknown[] } = { version: '1.0', objects: [] };
	if (templateJson !== undefined) {
		if (
			typeof templateJson !== 'object' ||
			templateJson === null ||
			!Array.isArray((templateJson as { objects?: unknown }).objects)
		) {
			error(400, 'templateJson must be an object with an "objects" array');
		}
		safeTemplate = templateJson as { version: string; objects: unknown[] };
	}

	const baseSlug = slugify(name);
	const slug = await findAvailableSlug(db, baseSlug);

	const [canvas] = await db
		.insert(canvases)
		.values({
			userId: locals.user.id,
			name: name.trim(),
			slug,
			width: width || 1200,
			height: height || 630,
			backgroundType: backgroundType || 'color',
			backgroundValue: backgroundValue || '#ffffff',
			templateJson: safeTemplate
		})
		.returning();

	return json(canvas, { status: 201 });
};
