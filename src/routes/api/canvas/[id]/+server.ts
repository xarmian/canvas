import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import {
	syncCanvasParams,
	applyParamUpdates,
	type ParamSchemaUpdate
} from '$lib/server/canvas-params';
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
	if (body.templateJson !== undefined) updates.templateJson = body.templateJson;
	if (body.backgroundType !== undefined) updates.backgroundType = body.backgroundType;
	if (body.backgroundValue !== undefined) updates.backgroundValue = body.backgroundValue;
	if (body.published !== undefined) updates.published = body.published;
	if (body.redirectUrl !== undefined) updates.redirectUrl = body.redirectUrl;
	if (body.ogTitle !== undefined) updates.ogTitle = body.ogTitle;
	if (body.ogDescription !== undefined) updates.ogDescription = body.ogDescription;
	if (body.width !== undefined) updates.width = body.width;
	if (body.height !== undefined) updates.height = body.height;

	// Optional schema-flag updates from the publish modal: array of
	// { name, required?, type? }. Skipped names that don't yet exist
	// in canvas_params; sync below will not pick them up either if
	// they aren't referenced by templateJson.
	const paramUpdates: ParamSchemaUpdate[] = Array.isArray(body.params) ? body.params : [];

	if (Object.keys(updates).length === 0 && paramUpdates.length === 0) {
		error(400, 'No fields to update');
	}

	const [updated] =
		Object.keys(updates).length > 0
			? await db.update(canvases).set(updates).where(eq(canvases.id, params.id)).returning()
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
