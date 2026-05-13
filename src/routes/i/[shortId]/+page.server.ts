/**
 * Public share page for a baked render (`/i/{shortId}`).
 *
 * Mirrors `/c/{slug}` behavior — same OG meta shape, same interstitial
 * UX, same http(s) scheme allowlist on `forwardUrl`. IDEA-161 Q7 picks
 * one v1 share model so crawler fixtures + a11y audits apply to both
 * surfaces.
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { renderedImages, canvases } from '$lib/server/db/schema';
import { eq, and, isNull, or, gt } from 'drizzle-orm';
import { resolveForwardUrl } from '$lib/server/forward-url';
import { FORMAT_EXTENSIONS } from '$lib/server/baked-render';
import { imageUrlFor, publicAppOrigin, shareUrlFor } from '$lib/server/render-permalink';
import type { OutputFormat } from '$lib/engine';

/** Mirrors the public-facing regex from `$lib/server/short-id.ts`. */
const SHORT_ID_RE = /^[A-Za-z0-9_-]{10}$/;

export const load: PageServerLoad = async ({ params, url }) => {
	if (!SHORT_ID_RE.test(params.shortId)) error(404, 'Not found');

	// Single-roundtrip read: row + canvas joined for the meta defaults.
	// `expiresAt` filter is in the SQL (not app code) so expired rows
	// never leak metadata via differential timing or response shape.
	const [row] = await db
		.select({
			id: renderedImages.id,
			format: renderedImages.format,
			width: renderedImages.width,
			height: renderedImages.height,
			forwardUrl: renderedImages.forwardUrl,
			ogTitle: renderedImages.ogTitle,
			ogDescription: renderedImages.ogDescription,
			canvasName: canvases.name,
			canvasOgTitle: canvases.ogTitle,
			canvasOgDescription: canvases.ogDescription
		})
		.from(renderedImages)
		.leftJoin(canvases, eq(canvases.id, renderedImages.canvasId))
		.where(
			and(
				eq(renderedImages.shortId, params.shortId),
				isNull(renderedImages.deletedAt),
				or(isNull(renderedImages.expiresAt), gt(renderedImages.expiresAt, new Date()))
			)
		)
		.limit(1);

	if (!row) error(404, 'Not found');

	// Bump `lastAccessedAt` async — never blocks the response. A failure
	// (transient DB hiccup) just leaves the previous timestamp; the next
	// successful access overwrites it.
	const renderRowId = row.id;
	setImmediate(() => {
		db.update(renderedImages)
			.set({ lastAccessedAt: new Date() })
			.where(eq(renderedImages.id, renderRowId))
			.catch((err) => {
				console.warn(`[i/${params.shortId}] lastAccessedAt bump failed`, err);
			});
	});

	const appUrl = publicAppOrigin(url.origin);
	const imageUrl = imageUrlFor(appUrl, params.shortId, row.format);
	const canonicalShareUrl = shareUrlFor(appUrl, params.shortId);

	// Meta defaults: baked value wins, then canvas-level defaults, then a
	// generic fallback. Identical to the resolution order POST uses when
	// nothing is provided. Keeps the share-card UX consistent regardless
	// of how thoroughly the integrator set up the canvas.
	const ogTitle = row.ogTitle ?? row.canvasOgTitle ?? row.canvasName ?? 'Canvas';
	const ogDescription = row.ogDescription ?? row.canvasOgDescription ?? 'Created with Canvas';

	// Defensive re-check on forwardUrl even though POST validated it at
	// create time — guards against direct DB mutation or a future column
	// repair script accidentally re-introducing a non-http(s) value.
	// Passes an empty params map because the value persisted on the row
	// is already substituted; any remaining `{{...}}` template syntax
	// would surface as `unsubstituted` and we'd just suppress the CTA,
	// which is exactly the right failsafe behaviour.
	let redirectUrl: string | null = null;
	if (row.forwardUrl) {
		const fwd = resolveForwardUrl(row.forwardUrl, {});
		if (fwd?.ok) {
			redirectUrl = fwd.url;
		} else if (fwd?.ok === false) {
			console.warn(`[i/${params.shortId}] forwardUrl re-check failed reason=${fwd.reason}`);
		}
	}

	const imageMimeType = FORMAT_EXTENSIONS[row.format as OutputFormat]?.contentType ?? 'image/png';

	return {
		shortId: params.shortId,
		width: row.width,
		height: row.height,
		imageUrl,
		imageMimeType,
		canonicalShareUrl,
		ogTitle,
		ogDescription,
		redirectUrl
	};
};
