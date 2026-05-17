import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { insertWithUniqueSlug, slugify } from '$lib/server/slug';
import { syncCanvasParams } from '$lib/server/canvas-params';
import type { FabricCanvasJson } from '$lib/engine';

/**
 * POST /api/canvas/[id]/duplicate — clone a canvas the caller owns.
 *
 * What's copied: name (with " (copy)" suffix), width, height, background,
 * templateJson, ogTitle/ogDescription, redirectUrl. canvas_params rows
 * are *not* copied directly — `syncCanvasParams` re-derives them from
 * the cloned templateJson, so a duplicate has the same bindings without
 * a manual JOIN/INSERT.
 *
 * What's NOT copied: published flag (always starts as draft), slug
 * (regenerated so the share URL is distinct), createdAt/updatedAt
 * (DB defaults), id (new UUID).
 *
 * Why a dedicated endpoint instead of a client-side fetch-then-POST:
 * keeping the copy server-side avoids a round-trip (and a transient
 * window where the user's browser holds the templateJson in memory),
 * and means a future "duplicate as template" feature lands here without
 * a public API change.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const [source] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, params.id), eq(canvases.userId, locals.user.id)));

	if (!source) error(404, 'Canvas not found');

	// Suffix " (copy)" — keep it ASCII so existing slug logic doesn't
	// have to special-case anything. If the user duplicates the same
	// canvas repeatedly the names stack ("Foo (copy) (copy)") which is
	// the same behavior Figma/Notion ship.
	const newName = `${source.name} (copy)`;
	// v1 slug scheme (TASK-92): auto-derive from name, resolve collisions
	// with the smallest free `-N` suffix. Repeated duplicates of the same
	// source produce `foo-copy`, `foo-copy-2`, `foo-copy-3`, etc. — no
	// nanoid noise in the URL. `insertWithUniqueSlug` retries on the
	// unique-index 23505 so two concurrent duplicates of the same source
	// land on distinct suffixes instead of one bubbling a 500.
	const duplicated = await insertWithUniqueSlug(db, slugify(newName), async (newSlug) => {
		const [row] = await db
			.insert(canvases)
			.values({
				userId: locals.user!.id,
				name: newName,
				slug: newSlug,
				width: source.width,
				height: source.height,
				backgroundType: source.backgroundType,
				backgroundValue: source.backgroundValue,
				templateJson: source.templateJson,
				ogTitle: source.ogTitle,
				ogDescription: source.ogDescription,
				redirectUrl: source.redirectUrl
				// published intentionally omitted → defaults to false (draft)
			})
			.returning();
		return row;
	});

	// Re-derive canvas_params for the new canvas. Without this the
	// duplicated editor would load with no Param Schema rows, and the
	// publish flow's "required params" UI would be empty until the
	// user makes any edit that triggers PATCH templateJson.
	await syncCanvasParams(db, duplicated.id, source.templateJson as unknown as FabricCanvasJson);

	return json(duplicated, { status: 201 });
};
