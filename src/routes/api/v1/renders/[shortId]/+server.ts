/**
 * GET + DELETE /api/v1/renders/{shortId}
 *
 * Read-side detail + soft-delete handlers for the Programmatic Render
 * API. Both gated by bearer-token auth — GET requires `render:read`,
 * DELETE requires `render:delete`.
 *
 * Not-found responses do not differentiate between "doesn't exist",
 * "wrong owner", and "soft-deleted" — all three return the same opaque
 * 404 so a probe can't learn which case it hit (information leak).
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases, renderedImages } from '$lib/server/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { requireApiKey } from '$lib/server/api-key';
import { getStorage } from '$lib/server/storage';
import { imageUrlFor, publicAppOrigin, shareUrlFor } from '$lib/server/render-permalink';
import { enforceApiKeyRateLimit } from '$lib/server/api-rate-limit';

/** shortId is `[A-Za-z0-9_-]{10}` per `$lib/server/short-id.ts`. Bail
 *  on anything else as a clean 404 so a malformed URL doesn't even
 *  touch the DB. */
const SHORT_ID_RE = /^[A-Za-z0-9_-]{10}$/;

export const GET: RequestHandler = async ({ locals, params, url }) => {
	requireApiKey(locals, 'render:read');
	const apiKey = locals.apiKey!;
	const decorate = enforceApiKeyRateLimit(apiKey.id, 'read');
	if (!SHORT_ID_RE.test(params.shortId)) error(404, 'render_not_found');

	const [row] = await db
		.select({
			id: renderedImages.id,
			shortId: renderedImages.shortId,
			canvasId: renderedImages.canvasId,
			canvasSlug: canvases.slug,
			canvasName: canvases.name,
			format: renderedImages.format,
			sizeBytes: renderedImages.sizeBytes,
			width: renderedImages.width,
			height: renderedImages.height,
			forwardUrl: renderedImages.forwardUrl,
			ogTitle: renderedImages.ogTitle,
			ogDescription: renderedImages.ogDescription,
			createdAt: renderedImages.createdAt,
			lastAccessedAt: renderedImages.lastAccessedAt,
			expiresAt: renderedImages.expiresAt
		})
		.from(renderedImages)
		.leftJoin(canvases, eq(canvases.id, renderedImages.canvasId))
		.where(
			and(
				eq(renderedImages.shortId, params.shortId),
				eq(renderedImages.userId, apiKey.userId),
				isNull(renderedImages.deletedAt)
			)
		)
		.limit(1);

	if (!row) error(404, 'render_not_found');

	const appUrl = publicAppOrigin(url.origin);
	return decorate(
		json({
			id: row.shortId,
			url: shareUrlFor(appUrl, row.shortId),
			imageUrl: imageUrlFor(appUrl, row.shortId, row.format),
			canvasId: row.canvasId,
			canvasSlug: row.canvasSlug,
			canvasName: row.canvasName,
			format: row.format,
			sizeBytes: row.sizeBytes,
			width: row.width,
			height: row.height,
			forwardUrl: row.forwardUrl,
			ogTitle: row.ogTitle,
			ogDescription: row.ogDescription,
			createdAt: row.createdAt.toISOString(),
			lastAccessedAt: row.lastAccessedAt.toISOString(),
			expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null
		})
	);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireApiKey(locals, 'render:delete');
	const apiKey = locals.apiKey!;
	const decorate = enforceApiKeyRateLimit(apiKey.id, 'read');
	if (!SHORT_ID_RE.test(params.shortId)) error(404, 'render_not_found');

	// Single round-trip soft-delete: marks `deletedAt` and returns the
	// storage key in one query. `deletedAt IS NULL` makes the second
	// DELETE on the same shortId a clean 404 (idempotency).
	const updated = await db
		.update(renderedImages)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(renderedImages.shortId, params.shortId),
				eq(renderedImages.userId, apiKey.userId),
				isNull(renderedImages.deletedAt)
			)
		)
		.returning({ storageKey: renderedImages.storageKey });

	if (updated.length === 0) error(404, 'render_not_found');

	// Best-effort blob deletion. The DB row is the source of truth; if
	// storage delete fails (network blip / S3 transient error) the bytes
	// are orphaned but the sweep CLI (TASK-175) reaps them on next run
	// based on the `deletedAt` marker.
	await getStorage()
		.delete(updated[0].storageKey)
		.catch((err) => {
			console.warn(
				`[renders] storage delete failed key=${updated[0].storageKey}`,
				err instanceof Error ? err.message : err
			);
		});

	return decorate(new Response(null, { status: 204 }));
};
