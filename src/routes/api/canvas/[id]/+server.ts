import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, and, ne, sql } from 'drizzle-orm';
import {
	syncCanvasParams,
	applyParamUpdates,
	type ParamSchemaUpdate
} from '$lib/server/canvas-params';
import { isSlugUniqueViolation, suggestAlternateSlug, validateSlug } from '$lib/server/slug';
import type { FabricCanvasJson } from '$lib/engine';

/** Helper: fetch canvas and verify ownership */
async function getOwnedCanvas(canvasId: string, userId: string) {
	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(eq(canvases.id, canvasId), eq(canvases.userId, userId)));

	return canvas ?? null;
}

/** Build the optimistic-concurrency ETag for a canvas. The version is
 *  the row's `lock_version` integer — bumped atomically by every
 *  PATCH inside the same UPDATE that performs the write. Clients
 *  pass this back via `If-Match` on PATCH; a stale value yields 412.
 *
 *  Why `lock_version` and not `updatedAt`: JS Date is millisecond
 *  precision. Two writes in the same millisecond would round-trip
 *  to the same `updatedAt.getTime()`, making the ETag visibly
 *  unchanged across two distinct row states — a stale If-Match
 *  could pass. `lock_version` is a monotonic counter, immune to
 *  clock granularity (Codex round 14 P2).
 *
 *  Quoted per RFC 9110 §8.8.3 (ETags are quoted-strings). The PATCH
 *  comparator strips the quotes so callers can submit either the
 *  bare digits or the quoted form. */
function canvasEtag(canvas: { lockVersion: number }): string {
	return `"${canvas.lockVersion}"`;
}

/** Strip `W/` weak prefix and surrounding quotes so the comparator
 *  doesn't reject `If-Match: "12345"` against the bare-digit version
 *  the server holds internally. */
function normalizeIfMatch(value: string): string {
	const trimmed = value.trim();
	const stripped = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
	return stripped.replace(/^"|"$/g, '');
}

/** Get a single canvas (owner only). Emits an ETag header so clients
 *  can capture the current version for optimistic-concurrency PATCHes
 *  via `If-Match`. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const canvas = await getOwnedCanvas(params.id, locals.user.id);
	if (!canvas) error(404, 'Canvas not found');

	return json(canvas, { headers: { ETag: canvasEtag(canvas) } });
};

/** Update a canvas (template_json, name, settings).
 *
 *  Optimistic concurrency (TASK-98 follow-up): if the request includes
 *  `If-Match: "<updatedAt-ms>"`, the handler compares it to the
 *  canvas's current `updatedAt` and returns 412 Precondition Failed
 *  on mismatch. This closes the server-side concurrent-write race
 *  that AbortController alone can't fix — once two PATCHes are
 *  in-flight at the server, ordering is undefined; If-Match makes
 *  the loser observable so the client can refetch and retry.
 *
 *  If-Match is opt-in. Existing callers (sharing fields, params)
 *  that don't send the header continue to use last-write-wins
 *  semantics, which is fine for field-by-field auto-saves. The
 *  slug-rename path opts in.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const canvas = await getOwnedCanvas(params.id, locals.user.id);
	if (!canvas) error(404, 'Canvas not found');

	const ifMatch = request.headers.get('if-match');
	// Pre-write precondition check + a snapshot of the version we're
	// committing against. The actual write below repeats the predicate
	// in the SQL `WHERE` so two concurrent PATCHes that both pass this
	// gate can't both commit (Codex round 7 P1) — Postgres serializes
	// the UPDATEs and only one matches on `lock_version`. Sub-ms
	// races are fully covered because `lock_version` is a monotonic
	// integer, not a wall-clock timestamp (Codex round 14 P2).
	let expectedLockVersion: number | null = null;
	if (ifMatch !== null) {
		const currentVersion = String(canvas.lockVersion);
		const provided = normalizeIfMatch(ifMatch);
		if (provided !== '*' && provided !== currentVersion) {
			return json(
				{
					error: 'precondition_failed',
					message: 'Canvas was updated by another request. Refresh and try again.',
					currentVersion
				},
				{
					status: 412,
					headers: { ETag: canvasEtag(canvas) }
				}
			);
		}
		// `*` says "any version is fine" — skip the SQL predicate. A
		// specific version means "only commit if THIS is still the
		// current row". Captured here and used in the
		// `eq(lockVersion)` WHERE clause below.
		if (provided !== '*') {
			expectedLockVersion = canvas.lockVersion;
		}
	}

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
				// Don't pass ignoreId here: a canvas currently owning `foo-2`
				// renaming to taken `foo` should be suggested `foo-3`, not
				// its own current slug. (No-op renames are short-circuited
				// above this branch — `slugInput !== canvas.slug` is true.)
				const suggestion = await suggestAlternateSlug(db, slugInput);
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

	// Catch the 23505 race: another writer claimed `updates.slug` between
	// our pre-write probe and this UPDATE. Convert to the same 409 +
	// suggestion shape the up-front collision branch returns so clients
	// have a single error contract for slug conflicts.
	//
	// Atomic optimistic concurrency (Codex round 7 P1): when the client
	// supplied a specific `If-Match`, the UPDATE's WHERE includes
	// `updated_at = expectedUpdatedAt`. Two concurrent PATCHes that
	// both passed the application-level precondition serialize at
	// the row in Postgres; only one matches on the version, the
	// loser's UPDATE returns zero rows. We treat zero-rows as 412.
	let updated;
	try {
		if (finalUpdates) {
			// Atomically bump `lock_version` in the SET clause and
			// require the expected version in the WHERE. Two
			// concurrent PATCHes that both pass the application
			// precondition serialize at the row level: only one
			// matches on the version, the loser's UPDATE returns
			// zero rows. `lock_version` is a monotonic integer
			// (TASK-98 round 14) so sub-ms races are also covered.
			const setClause = {
				...finalUpdates,
				lockVersion: sql`${canvases.lockVersion} + 1`
			};
			const whereClause =
				expectedLockVersion !== null
					? and(eq(canvases.id, params.id), eq(canvases.lockVersion, expectedLockVersion))
					: eq(canvases.id, params.id);
			const rows = await db.update(canvases).set(setClause).where(whereClause).returning();
			if (rows.length === 0) {
				// Either the row vanished (extremely unlikely — owner
				// check above would 404 first) or another writer raced
				// us and bumped updated_at. Refetch to surface the
				// fresh version to the client.
				const fresh = await getOwnedCanvas(params.id, locals.user.id);
				if (!fresh) error(404, 'Canvas not found');
				return json(
					{
						error: 'precondition_failed',
						message: 'Canvas was updated by another request. Refresh and try again.',
						currentVersion: String(fresh.updatedAt.getTime())
					},
					{ status: 412, headers: { ETag: canvasEtag(fresh) } }
				);
			}
			updated = rows[0];
		} else {
			updated = canvas;
		}
	} catch (err) {
		if (isSlugUniqueViolation(err) && typeof updates.slug === 'string') {
			// See ignoreId comment above — same rationale: the conflict
			// branch implies the requested slug differs from the canvas's
			// own, so a suggestion that matches the canvas's current slug
			// would be useless.
			const suggestion = await suggestAlternateSlug(db, updates.slug);
			return json(
				{
					error: 'slug_taken',
					message: `"${updates.slug}" is already in use. Try "${suggestion}".`,
					suggestion
				},
				{ status: 409 }
			);
		}
		throw err;
	}

	// Re-derive canvas_params from the new templateJson (if templateJson
	// was part of this PATCH) so bindings/conditional rules are reflected
	// in the validation table. Then apply user-driven flag updates.
	if (body.templateJson !== undefined) {
		await syncCanvasParams(db, params.id, body.templateJson as FabricCanvasJson);
	}
	if (paramUpdates.length > 0) {
		await applyParamUpdates(db, params.id, paramUpdates);
	}

	return json(updated, { headers: { ETag: canvasEtag(updated) } });
};

/** Delete a canvas */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const canvas = await getOwnedCanvas(params.id, locals.user.id);
	if (!canvas) error(404, 'Canvas not found');

	await db.delete(canvases).where(eq(canvases.id, params.id));

	return json({ success: true });
};
