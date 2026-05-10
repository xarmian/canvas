import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import {
	syncCanvasParams,
	applyParamUpdates,
	type ParamSchemaUpdate
} from '$lib/server/canvas-params';
import { suggestAlternateSlug, validateSlug } from '$lib/server/slug';
import type { FabricCanvasJson } from '$lib/engine';

/** Helper: fetch canvas and verify ownership */
async function getOwnedCanvas(canvasId: string, userId: string) {
	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, canvasId), eq(canvases.userId, userId)));

	return canvas ?? null;
}

/** Get a single canvas (owner only) */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const canvas = await getOwnedCanvas(params.id, locals.user.id);
	if (!canvas) error(404, 'Canvas not found');

	return json(canvas);
};

/** Update a canvas (template_json, name, settings) */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const canvas = await getOwnedCanvas(params.id, locals.user.id);
	if (!canvas) error(404, 'Canvas not found');

	const body = await request.json();
	const updates: Record<string, unknown> = {};

	if (body.name !== undefined) updates.name = body.name;
	// Slug rename (TASK-92): accept a user-chosen slug. Validate format,
	// check the global unique constraint excluding the current canvas
	// (a no-op rename to the existing slug must succeed), and on
	// collision return a 409 with a suggested alternative so the UI
	// (TASK-98) can offer one-click acceptance. No back-compat redirect
	// from the old slug — pre-launch latitude (PLAN-81).
	let slugSubmitted = false;
	if (body.slug !== undefined) {
		// Trim only — case is part of the format contract; uppercase is
		// rejected explicitly so the user notices the typo instead of
		// having it silently rewritten.
		const slugInput = typeof body.slug === 'string' ? body.slug.trim() : '';
		const validation = validateSlug(slugInput);
		if (!validation.ok) {
			return json({ error: 'invalid_slug', message: validation.reason }, { status: 400 });
		}
		slugSubmitted = true;
		if (slugInput !== canvas.slug) {
			const [collision] = await db
				.select({ id: canvases.id })
				.from(canvases)
				.where(and(eq(canvases.slug, slugInput), ne(canvases.id, canvas.id)));
			if (collision) {
				const suggestion = await suggestAlternateSlug(db, slugInput, { ignoreId: canvas.id });
				return json(
					{
						error: 'slug_taken',
						message: `"${slugInput}" is already in use. Try "${suggestion}".`,
						suggestion
					},
					{ status: 409 }
				);
			}
			updates.slug = slugInput;
		}
	}
	if (body.templateJson !== undefined) updates.templateJson = body.templateJson;
	if (body.backgroundType !== undefined) updates.backgroundType = body.backgroundType;
	if (body.backgroundValue !== undefined) updates.backgroundValue = body.backgroundValue;
	if (body.published !== undefined) updates.published = body.published;
	if (body.redirectUrl !== undefined) updates.redirectUrl = body.redirectUrl;
	if (body.ogTitle !== undefined) updates.ogTitle = body.ogTitle;
	if (body.ogDescription !== undefined) updates.ogDescription = body.ogDescription;
	if (body.width !== undefined) updates.width = body.width;
	if (body.height !== undefined) updates.height = body.height;
	// Folder/tags are dashboard-organization metadata. Folder is a single
	// trimmed string (empty/whitespace → null so "Uncategorized" stays a
	// distinct virtual bucket on the dashboard). Tags are sanitized to a
	// trimmed unique array — duplicates and empties are silently dropped
	// so a careless paste doesn't pollute the per-user tag namespace.
	if (body.folder !== undefined) {
		const f = typeof body.folder === 'string' ? body.folder.trim() : '';
		updates.folder = f.length > 0 ? f : null;
	}
	if (body.tags !== undefined) {
		if (!Array.isArray(body.tags)) error(400, 'tags must be an array of strings');
		const cleaned = Array.from(
			new Set(
				(body.tags as unknown[])
					.map((t) => (typeof t === 'string' ? t.trim() : ''))
					.filter((t) => t.length > 0)
			)
		);
		updates.tags = cleaned;
	}

	// Optional schema-flag updates from the publish modal: array of
	// { name, required?, type? }. Skipped names that don't yet exist
	// in canvas_params; sync below will not pick them up either if
	// they aren't referenced by templateJson.
	const paramUpdates: ParamSchemaUpdate[] = Array.isArray(body.params) ? body.params : [];

	if (Object.keys(updates).length === 0 && paramUpdates.length === 0 && !slugSubmitted) {
		error(400, 'No fields to update');
	}

	// If only params (no canvas columns) are being patched, force an
	// updatedAt bump anyway. Without this, a publish-modal schema edit
	// (mark a param required, change its type) leaves canvases.updatedAt
	// untouched — and the public render route's `_v` token derives from
	// updatedAt. A user who copied a 1-year immutable embed URL would
	// keep getting CDN-cached 200s even after validation got stricter.
	// Bumping updatedAt forces a new token, so old immutable URLs become
	// "stale `_v`" and downgrade to short-cache (the safe default).
	const finalUpdates =
		Object.keys(updates).length > 0
			? updates
			: paramUpdates.length > 0
				? { updatedAt: new Date() }
				: null;

	const [updated] = finalUpdates
		? await db.update(canvases).set(finalUpdates).where(eq(canvases.id, params.id)).returning()
		: [canvas];

	// Re-derive canvas_params from the new templateJson (if templateJson
	// was part of this PATCH) so bindings/conditional rules are reflected
	// in the validation table. Then apply user-driven flag updates.
	if (body.templateJson !== undefined) {
		await syncCanvasParams(db, params.id, body.templateJson as FabricCanvasJson);
	}
	if (paramUpdates.length > 0) {
		await applyParamUpdates(db, params.id, paramUpdates);
	}

	return json(updated);
};

/** Delete a canvas */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const canvas = await getOwnedCanvas(params.id, locals.user.id);
	if (!canvas) error(404, 'Canvas not found');

	await db.delete(canvases).where(eq(canvases.id, params.id));

	return json({ success: true });
};
