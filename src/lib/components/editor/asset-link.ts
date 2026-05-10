/**
 * Editor-side translator for the `asset://{id}` URL scheme (TASK-116).
 *
 * Persisted templateJson stores asset references as `asset://{id}` so a
 * canvas survives storage migrations and asset-URL changes. The editor
 * itself can't render `asset://` directly — Fabric needs an actual
 * fetchable URL — so we run a one-time translation in both directions:
 *
 *   - On load: walk the JSON, batch-look-up every referenced id via
 *     `/api/library?ids=...`, replace each `asset://` string with the
 *     resolved public URL, and stamp the resolved id onto the layer as
 *     a custom property (`srcAssetId`, `fallbackSrcAssetId`,
 *     `iconImageAssetId`). Stamping the id lets save-time translation
 *     reverse the rewrite without re-walking the DB.
 *
 *   - On save: walk the toObject() output, and for any layer with an
 *     id stamped, replace the corresponding URL field with
 *     `asset://{id}` so the persisted JSON is portable again.
 *
 * Lifecycle of `srcAssetId` etc.:
 *   - Set when the user picks from the asset library (AddImageModal).
 *   - Set when an `asset://` URL is resolved at canvas-load time.
 *   - Cleared by the PropertyPanel "Unlink" affordance (or any code
 *     that wants to detach the layer from the library reference).
 *
 * Single-source ownership: the FabricObject is the source of truth in
 * memory. A user can edit the resolved URL in the PropertyPanel src
 * field — that does NOT clear the assetId, on the assumption that they
 * just want to test a different URL. The Unlink button is the explicit
 * detach.
 */

// Defined inline (rather than imported from `$lib/server/asset-resolver`)
// so the editor bundle stays browser-safe — Vite's sveltekit-guard plugin
// blocks any client-side import of `$lib/server/*`. Keep the literal in
// sync with `ASSET_URL_PROTOCOL` on the server.
const ASSET_URL_PROTOCOL = 'asset://';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 1×1 transparent PNG used as a fallback URL for unresolved `asset://`
 * references at canvas-load time. Fabric's loadFromJSON aborts entire
 * canvas hydration if any image src fails to load — leaving the user
 * with a blank canvas after `canvas.clear()` and a "blank canvas"
 * snapshot in undo history. By substituting an instantly-loadable
 * data URL we keep hydration alive: the layer renders invisibly in
 * the editor (its assetId stamp remains, so the save serializer
 * still emits the original `asset://{id}`), and the user can use the
 * Unlink + repick affordance to repair the reference. No data loss.
 */
const UNRESOLVED_ASSET_PLACEHOLDER =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

/** Per-field mapping from the URL prop to the assetId stamp prop. The
 *  server-side resolver walks the same set; keep both in sync. */
export const ASSET_LINK_FIELDS = [
	{ urlProp: 'src', idProp: 'srcAssetId' },
	{ urlProp: 'fallbackSrc', idProp: 'fallbackSrcAssetId' },
	{ urlProp: 'iconImage', idProp: 'iconImageAssetId' }
] as const;

/** Subset of FabricCanvasJson we manipulate. Typed loosely so we don't
 *  fight the Fabric/engine type duality (engine has its own narrower
 *  FabricObject type; Fabric ships its own; we accept whichever shape
 *  has the asset URL fields). */
interface AssetLayer {
	[key: string]: unknown;
}

interface AssetCanvasJson {
	objects?: AssetLayer[];
}

/** Extract the UUID from `asset://{id}`, or null if `value` isn't a
 *  well-formed asset reference. Mirrors the server resolver's parsing
 *  rules. Trims so trailing whitespace from hand-edited JSON doesn't
 *  break recognition. */
export function parseAssetId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed.startsWith(ASSET_URL_PROTOCOL)) return null;
	const id = trimmed.slice(ASSET_URL_PROTOCOL.length);
	if (!UUID_RE.test(id)) return null;
	return id;
}

/**
 * Walk a templateJson and collect every unique `asset://` id referenced
 * across image / fallback / badge-icon URL fields. Returns an empty
 * array when there are no asset refs (the editor's load path uses this
 * to skip the lookup round-trip entirely on canvases with absolute URLs).
 */
export function collectAssetIdsFromTemplate(json: AssetCanvasJson): string[] {
	const ids = new Set<string>();
	for (const obj of json.objects ?? []) {
		for (const { urlProp } of ASSET_LINK_FIELDS) {
			const id = parseAssetId(obj[urlProp]);
			if (id) ids.add(id);
		}
	}
	return [...ids];
}

/**
 * Replace every `asset://` reference in `json` with its resolved public
 * URL using the provided lookup map. Stamps the resolved id onto the
 * layer as `srcAssetId` / `fallbackSrcAssetId` / `iconImageAssetId` so
 * save-time translation can reverse the rewrite without a second
 * round-trip.
 *
 * Mutates the input — callers feed in their own deep clone.
 *
 * Unresolved ids (rejected by ownership filter, deleted, malformed)
 * fall back to a 1×1 transparent placeholder URL so Fabric's
 * `loadFromJSON` doesn't abort the entire canvas hydration when one
 * image fails. The id stamp is still applied, so the save serializer
 * re-emits the original `asset://{id}` and no persisted data is lost.
 * Result: the broken layer renders invisibly in the editor, the user
 * can repair it via the Unlink-and-repick flow, and a save before any
 * fix preserves the original asset reference.
 */
export function rewriteAssetRefsForEditor(
	json: AssetCanvasJson,
	idToUrl: ReadonlyMap<string, string>
): void {
	for (const obj of json.objects ?? []) {
		for (const { urlProp, idProp } of ASSET_LINK_FIELDS) {
			const id = parseAssetId(obj[urlProp]);
			if (!id) continue;
			const url = idToUrl.get(id);
			obj[urlProp] = url ?? UNRESOLVED_ASSET_PLACEHOLDER;
			obj[idProp] = id;
		}
	}
}

/**
 * Walk Fabric's `toObject()` output and rewrite tracked asset URLs back
 * to `asset://{id}` so the persisted JSON is portable. Inverse of
 * `rewriteAssetRefsForEditor` — runs in autosave / publish.
 *
 * Layers whose user manually edited the URL but kept the id stamped
 * still get rewritten to `asset://{id}`. The id stamp is the truth of
 * "this field is library-linked"; if the user wants to detach, they
 * use the Unlink affordance (which clears the id stamp).
 */
export function serializeAssetLinks(json: AssetCanvasJson): void {
	for (const obj of json.objects ?? []) {
		for (const { urlProp, idProp } of ASSET_LINK_FIELDS) {
			const id = obj[idProp];
			if (typeof id !== 'string' || !UUID_RE.test(id)) continue;
			obj[urlProp] = `${ASSET_URL_PROTOCOL}${id}`;
		}
	}
}

interface BatchLookupResponse {
	items: { id: string; url: string }[];
}

/**
 * Fetch the public URLs for a set of asset ids via the batched library
 * endpoint. Returns a Map keyed by id. Missing ids (rejected by
 * ownership / deleted) simply don't appear in the result.
 *
 * Errors are caught and surfaced as an empty map rather than thrown —
 * the editor degrades gracefully (asset:// strings remain unresolved
 * and Fabric just skips loading those layers' images).
 */
export async function fetchAssetUrlsByIds(ids: string[]): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	if (ids.length === 0) return result;
	try {
		const params = new URLSearchParams({ ids: ids.join(',') });
		const res = await fetch(`/api/library?${params.toString()}`);
		if (!res.ok) return result;
		const body = (await res.json()) as BatchLookupResponse;
		for (const item of body.items ?? []) {
			if (typeof item.id === 'string' && typeof item.url === 'string') {
				result.set(item.id, item.url);
			}
		}
	} catch {
		// fall through — map stays empty
	}
	return result;
}
