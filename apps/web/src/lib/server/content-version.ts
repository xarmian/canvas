/**
 * Canvas content-version token (`_v` URL param).
 *
 * Why this exists
 * ===============
 * Social-media crawlers (Twitter / Bluesky / Discord / Slack / LinkedIn)
 * cache OG images by URL. If the share URL emits a stable `og:image=
 * /c/{slug}/image.png?...`, an edit to the canvas does NOT propagate
 * to those caches — the user retweets the same URL and sees the OLD
 * preview indefinitely.
 *
 * The fix is to change the URL whenever the rendered bytes would
 * change. We append `_v=<token>` where the token is a short hash of
 * everything that affects the render output:
 *   - `canvas.updatedAt` — bumped automatically by Drizzle on any
 *     PATCH that touches the row, including param-only edits
 *     (`api/canvas/[id]/+server.ts:99-103`).
 *   - The user's font-library fingerprint — `getLiveUserFontDescriptors`
 *     returns asset IDs, so delete-then-reupload of the same filename
 *     bumps the fingerprint and busts the cache.
 *
 * The same token is consumed by the public render route
 * (`/c/{slug}/{file}/+server.ts:140-145`) to opt-in immutable cache
 * headers when a request URL's `_v` matches the current token (used
 * by embed-code snippets — TASK-69 — that want hard CDN caching).
 *
 * Contract for future changes
 * ===========================
 * If you add a new render-affecting input, append it to the hash here
 * AND in `[file]/+server.ts`'s use of this helper. Otherwise stale
 * card previews come back. The 12-char SHA-256 prefix is plenty —
 * collisions across a single canvas's edit history are vanishingly
 * unlikely.
 *
 * `0` is the empty-fingerprint sentinel so a canvas with zero
 * registered fonts still produces a valid token (rather than hashing
 * the literal empty string and never being able to distinguish that
 * state from "no fonts joined to nothing").
 */
import { createHash } from 'node:crypto';
import { getLiveUserFontDescriptors } from './user-fonts';

/** Length (in hex chars) of the truncated SHA-256 we expose as `_v`.
 *  12 = 48 bits of entropy = collision-resistant for any realistic
 *  edit history while keeping URLs tidy. */
const TOKEN_HEX_CHARS = 12;

/** Build the 12-hex-char content-version token for a canvas. The
 *  inputs ARE the contract — see the file-header doc.
 *
 *  `assetSetVersion` (TASK-117) makes the token sensitive to
 *  asset-row mutations even when the canvas's templateJson is
 *  unchanged. Without it, social-CDN immutable caches would keep
 *  serving the resolved render of a now-deleted asset until the
 *  user edited the canvas. Empty string is a valid input — that's
 *  the "canvas has no asset:// refs" state, distinct from
 *  "fingerprint not yet computed". */
export function buildContentVersionToken(
	canvasUpdatedAtMs: string,
	fontSetVersion: string,
	assetSetVersion = ''
): string {
	return createHash('sha256')
		.update(`${canvasUpdatedAtMs}|${fontSetVersion}|${assetSetVersion}`)
		.digest('hex')
		.slice(0, TOKEN_HEX_CHARS);
}

/** Build the font-set fingerprint from a list of font descriptors.
 *  Sorted asset IDs joined with `|`. Empty string when no fonts. The
 *  render route already loads the descriptors for sanitization
 *  purposes; passing them in here keeps it from re-querying. */
export function fontSetVersionFromDescriptors(descriptors: Array<{ id: string }>): string {
	return descriptors
		.map((d) => d.id)
		.sort()
		.join('|');
}

/** Build the asset-set fingerprint from a list of `(id, storageKey)`
 *  entries. Folded into the render cache key so deleting / replacing
 *  an asset that a published canvas references invalidates the
 *  canvas's cached renders without requiring a canvas edit
 *  (TASK-117). Empty string when the canvas has no `asset://` refs
 *  OR all referenced ids have been deleted. */
export function assetSetVersionFromEntries(
	entries: Array<{ id: string; storageKey: string }>
): string {
	if (entries.length === 0) return '';
	return entries.map((e) => `${e.id}:${e.storageKey}`).join('|');
}

/** Build the user font-set fingerprint that feeds the content-version
 *  token. Sorted asset IDs joined with `|`; empty string when the user
 *  has zero fonts registered. */
export async function buildFontSetVersion(userId: string): Promise<string> {
	const descriptors = await getLiveUserFontDescriptors(userId);
	return fontSetVersionFromDescriptors(descriptors);
}

/** One-call helper that resolves `_v` for a canvas owned by `userId`.
 *  Used by the share-page server load to embed `_v=<token>` in the
 *  og:image URL. The render route derives the same token directly
 *  (it already needs the font descriptors for cache-key purposes —
 *  see `[file]/+server.ts`).
 *
 *  `templateJson` is read for `asset://` references; the resolved
 *  `(id, storage_key)` rows feed the asset-set fingerprint so a
 *  delete/replace on a referenced asset rolls the token (TASK-117).
 *  Pass `null` if the caller doesn't have the templateJson handy —
 *  the asset fingerprint will be empty, equivalent to the v0.5
 *  pre-TASK-117 behavior. */
export async function resolveContentVersion(
	canvasUpdatedAt: Date,
	userId: string,
	templateJson: import('$lib/engine/types').FabricCanvasJson | null = null
): Promise<string> {
	const fontSetVersion = await buildFontSetVersion(userId);
	let assetSetVersion = '';
	if (templateJson) {
		const { collectAssetReferences, loadAssetFingerprint } = await import('./asset-resolver');
		const ids = collectAssetReferences(templateJson);
		if (ids.length > 0) {
			const entries = await loadAssetFingerprint(ids, userId);
			assetSetVersion = assetSetVersionFromEntries(entries);
		}
	}
	return buildContentVersionToken(
		canvasUpdatedAt.getTime().toString(),
		fontSetVersion,
		assetSetVersion
	);
}
