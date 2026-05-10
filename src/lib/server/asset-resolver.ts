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

/** Validates an asset id is a well-formed UUID before passing to
 * `inArray(assets.id, ...)`. The DB column is a Postgres `uuid`, so a
 * malformed value (`asset://not-a-uuid`) would make the query throw
 * instead of falling through to the placeholder path. Match RFC 4122
 * canonical form (any version, any variant). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Image layers gain a `fallbackSrc` field in TASK-86. Until that lands the
 * resolver still walks it conditionally so the two tasks compose cleanly
 * without a follow-up rev. */
type ImageLayerWithFallback = FabricObject & { fallbackSrc?: string };

/**
 * Walks a template JSON and rewrites any `asset://{id}` URLs in image
 * `src` / `fallbackSrc` fields to their resolved public URLs, AND
 * pre-loads the asset bytes from server-side storage so the renderer
 * doesn't have to round-trip through HTTP.
 *
 * # Why preload
 *
 * `storage.getUrl()` for the local-storage adapter returns relative paths
 * (`/api/assets/...`) and S3 endpoints can be private hosts in dev — both
 * are rejected by the renderer's SSRF-bounded fetch layer (`isUrlSafe`).
 * Loading the buffer directly via `storage.read()` sidesteps that without
 * weakening SSRF defense for untrusted external URLs: only owned assets
 * (already authorized via the `userId` filter) take the trusted-bytes path.
 *
 * # Return value
 *
 * The map is keyed by the resolved public URL (the same string that ends
 * up in the rewritten templateJson) so the renderer's `loadImagesParallel`
 * can look up preloaded buffers without any extra plumbing.
 *
 * # Authorization
 *
 * Single batched SELECT, filtered by `ownerId`. Unresolved references
 * (cross-user, deleted, malformed/non-UUID id) are left as-is — the
 * renderer's image fetcher will treat them as unfetchable and the layer
 * gets the placeholder.
 *
 * # Cache invalidation caveat
 *
 * The render cache key is derived from `canvas.updatedAt` + font version,
 * neither of which moves when an asset row is mutated. A user who deletes
 * an asset and re-views a published canvas will keep getting the cached
 * resolved render until the canvas itself is edited. Tracked as a
 * follow-up — for v0.5 (no users) the workaround is "edit the canvas".
 *
 * Mutates the input JSON in place — the renderer already feeds in a
 * deep clone (see `mergeParams`), so this is safe to call before
 * `applyConditionalStyles` and `render()`.
 *
 * No-op when the template contains no `asset://` references — saves both
 * the DB round-trip and the storage reads on canvases that only use
 * absolute URLs.
 */
export async function resolveAssetReferences(
	templateJson: FabricCanvasJson,
	ownerId: string
): Promise<Map<string, Buffer>> {
	const empty = new Map<string, Buffer>();
	const objects: ImageLayerWithFallback[] = templateJson.objects ?? [];
	if (objects.length === 0) return empty;

	// Collect every asset ID referenced anywhere in the JSON. Use a Set
	// so duplicate refs across layers cost a single row instead of N.
	// Skips malformed (non-UUID) ids — those would throw at the SQL
	// layer when fed into `inArray(assets.id, ...)` against a uuid
	// column.
	const referencedIds = new Set<string>();
	for (const obj of objects) {
		const srcId = parseAssetId(obj.src);
		if (srcId) referencedIds.add(srcId);
		const fallbackId = parseAssetId(obj.fallbackSrc);
		if (fallbackId) referencedIds.add(fallbackId);
	}
	if (referencedIds.size === 0) return empty;

	// Single SELECT — owner filter is enforced in the WHERE clause so a
	// foreign asset id mixed in with the user's own ids gets dropped at
	// the DB layer, not in JS.
	const rows = await db
		.select({ id: assets.id, storageKey: assets.storageKey })
		.from(assets)
		.where(and(inArray(assets.id, [...referencedIds]), eq(assets.userId, ownerId)));

	if (rows.length === 0) return empty;

	const storage = getStorage();
	const idToUrl = new Map<string, string>();
	const preloaded = new Map<string, Buffer>();

	// Load each owned asset's bytes directly from storage and key the
	// preloaded map by the resolved URL. Concurrent across rows. A
	// storage read failure (race with delete, transient I/O) leaves the
	// URL unpreloaded — the renderer's HTTP path is the fallback, and if
	// that fails too the layer gets the placeholder.
	await Promise.all(
		rows.map(async (row) => {
			const url = storage.getUrl(row.storageKey);
			idToUrl.set(row.id, url);
			try {
				const buf = await storage.read(row.storageKey);
				preloaded.set(url, buf);
			} catch {
				// fall through to renderer's HTTP fetch path
			}
		})
	);

	// Rewrite in place. Unresolved refs (rejected by ownership filter or
	// missing) keep their original `asset://` string; the renderer's
	// image fetcher treats it as unfetchable → placeholder fallback.
	for (const obj of objects) {
		const newSrc = rewrite(obj.src, idToUrl);
		if (newSrc !== undefined) obj.src = newSrc;
		const newFallback = rewrite(obj.fallbackSrc, idToUrl);
		if (newFallback !== undefined) obj.fallbackSrc = newFallback;
	}

	return preloaded;
}

/** Extract the ID from `asset://{id}` if the string is an asset reference
 * AND the id is a well-formed UUID. Returns null otherwise — including
 * the malformed-UUID case, so a hand-edited typo can't reach the SQL
 * `inArray(assets.id, ...)` against a uuid column and throw. Trims so
 * trailing whitespace from hand-edited JSON doesn't break recognition. */
function parseAssetId(value: string | undefined | null): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed.startsWith(ASSET_URL_PROTOCOL)) return null;
	const id = trimmed.slice(ASSET_URL_PROTOCOL.length);
	if (!UUID_RE.test(id)) return null;
	return id;
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
