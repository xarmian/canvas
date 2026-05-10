/**
 * `asset://{id}` URL scheme resolver.
 *
 * Lets a canvas's template JSON reference uploaded assets by ID instead of
 * by absolute URL — so a single platform logo / shared icon can be uploaded
 * once and re-used across many canvases without re-uploading or hard-coding
 * external CDN URLs into every templateJson.
 *
 * Resolution happens server-side, before the renderer runs. Walks the
 * template, finds image-layer `src` (and `fallbackSrc`, once TASK-86 lands)
 * URLs that start with `asset://`, looks the IDs up in the `assets` table
 * filtered by `ownerId`, and rewrites the strings to the storage adapter's
 * public URL.
 *
 * # Authorization
 *
 * The resolver only resolves asset rows whose `userId === ownerId`. Cross-
 * user references are silently dropped — the original `asset://{id}`
 * string is left in place, the renderer's image fetcher treats it as
 * unfetchable, and the layer renders the gray placeholder (or, post
 * TASK-86, the configured `fallbackSrc`). This is the cross-user defense
 * called out in the TASK-89 acceptance criteria.
 *
 * Likewise, deleted asset IDs simply don't appear in the lookup result and
 * fall through to the same placeholder path. No 500s.
 *
 * # Cache coherency caveat
 *
 * The render cache key includes the canvas's content version, which moves
 * when the canvas's templateJson changes. If a user deletes an asset and
 * re-uploads it under a new ID without editing the canvas, the cache key
 * doesn't move — but the canvas's templateJson still references the old
 * `asset://` ID, so the resolver will see "not found" and fall through to
 * a placeholder anyway. The "delete + re-upload as same ID" scenario is
 * impossible (UUIDs). Acceptable behavior for v0.5.
 */

import { db } from './db/index.js';
import { assets } from './db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { getStorage } from './storage/index.js';
import type { FabricCanvasJson, FabricObject } from '$lib/engine/types.js';

/** URL scheme prefix recognized by the resolver. Exported so other server
 * modules (e.g. future editor save translation) can reference the same
 * literal. */
export const ASSET_URL_PROTOCOL = 'asset://';

/** Image layers gain a `fallbackSrc` field in TASK-86. Until that lands the
 * resolver still walks it conditionally so the two tasks compose cleanly
 * without a follow-up rev. */
type ImageLayerWithFallback = FabricObject & { fallbackSrc?: string };

/**
 * Walks a template JSON and rewrites any `asset://{id}` URLs in image
 * `src` / `fallbackSrc` fields to their resolved public URLs.
 *
 * Mutates the input JSON in place — the renderer already feeds in a
 * deep clone (see `mergeParams`), so this is safe to call before
 * `applyConditionalStyles` and `render()`.
 *
 * Single batched DB round-trip: SELECT for all referenced IDs,
 * filtered by `ownerId`. Unresolved references (cross-user, deleted,
 * malformed ID) are left as-is — the image-fetch layer treats them as
 * unfetchable.
 *
 * No-op when the template contains no `asset://` references — saves the
 * DB round-trip on canvases that only use absolute URLs.
 */
export async function resolveAssetReferences(
	templateJson: FabricCanvasJson,
	ownerId: string
): Promise<void> {
	const objects: ImageLayerWithFallback[] = templateJson.objects ?? [];
	if (objects.length === 0) return;

	// Collect every asset ID referenced anywhere in the JSON. Use a Set
	// so duplicate refs across layers cost a single row instead of N.
	const referencedIds = new Set<string>();
	for (const obj of objects) {
		const srcId = parseAssetId(obj.src);
		if (srcId) referencedIds.add(srcId);
		const fallbackId = parseAssetId(obj.fallbackSrc);
		if (fallbackId) referencedIds.add(fallbackId);
	}
	if (referencedIds.size === 0) return;

	// Single SELECT — owner filter is enforced in the WHERE clause so a
	// foreign asset id mixed in with the user's own ids gets dropped at
	// the DB layer, not in JS.
	const rows = await db
		.select({ id: assets.id, storageKey: assets.storageKey })
		.from(assets)
		.where(and(inArray(assets.id, [...referencedIds]), eq(assets.userId, ownerId)));

	if (rows.length === 0) return;

	const storage = getStorage();
	const idToUrl = new Map<string, string>();
	for (const row of rows) {
		idToUrl.set(row.id, storage.getUrl(row.storageKey));
	}

	// Rewrite in place. Unresolved refs (rejected by ownership filter or
	// missing) keep their original `asset://` string; the renderer's
	// image fetcher treats it as unfetchable → placeholder fallback.
	for (const obj of objects) {
		const newSrc = rewrite(obj.src, idToUrl);
		if (newSrc !== undefined) obj.src = newSrc;
		const newFallback = rewrite(obj.fallbackSrc, idToUrl);
		if (newFallback !== undefined) obj.fallbackSrc = newFallback;
	}
}

/** Extract the ID from `asset://{id}`, or null if the string isn't an
 * asset reference. Trims so trailing whitespace from hand-edited JSON
 * doesn't break recognition. */
function parseAssetId(value: string | undefined | null): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed.startsWith(ASSET_URL_PROTOCOL)) return null;
	const id = trimmed.slice(ASSET_URL_PROTOCOL.length);
	return id.length > 0 ? id : null;
}

/** Returns the rewritten URL if `value` is an asset:// ref that resolved,
 * `undefined` otherwise (so callers can leave the original string
 * untouched). Distinct from returning `value` unchanged so the caller
 * knows when a real change happened. */
function rewrite(
	value: string | undefined | null,
	idToUrl: Map<string, string>
): string | undefined {
	const id = parseAssetId(value);
	if (!id) return undefined;
	const url = idToUrl.get(id);
	return url ?? undefined;
}
