/**
 * Editor-side font registry.
 *
 * The editor needs to know which fonts are available to the user
 * (bundled defaults + user-uploaded customs) so the property panel's
 * font dropdown can offer them, and so Fabric's text rendering can
 * use them. User fonts must be loaded into `document.fonts` (via the
 * FontFace API) before Fabric renders — otherwise text falls back to
 * a system font and the canvas mismeasures it.
 *
 * This module is the single source of truth: editor +page.svelte
 * calls `loadUserFonts()` on mount, and the property panel reads
 * `fontStore.fonts`.
 */

export interface FontEntry {
	/** The string stored in templateJson and used as the CSS family
	 *  name. For bundled fonts this is the canonical name (e.g. "Inter").
	 *  For user fonts this is the userId-namespaced form returned by
	 *  /api/fonts so two users uploading "Brand.ttf" can't collide in
	 *  the process-global GlobalFonts registry. */
	family: string;
	/** What the dropdown shows. For bundled fonts this matches `family`;
	 *  for user fonts this is the un-namespaced derived name. */
	displayName: string;
	source: 'bundled' | 'user';
	/** URL where the font can be loaded from (for user fonts). */
	url?: string;
	/** Asset id (user fonts only) — used to dedup adds and to remove
	 *  entries that are no longer present in /api/fonts. */
	assetId?: string;
}

/** Bundled families. The renderer registers these via initDefaultFonts;
 *  the editor relies on the system or page-level @font-face to make
 *  them available client-side. Order roughly matches v0.1 frequency. */
export const BUNDLED_FONTS: readonly FontEntry[] = [
	{ family: 'Inter', displayName: 'Inter', source: 'bundled' },
	{ family: 'Arial', displayName: 'Arial', source: 'bundled' },
	{ family: 'Georgia', displayName: 'Georgia', source: 'bundled' },
	{ family: 'Courier New', displayName: 'Courier New', source: 'bundled' },
	{ family: 'Times New Roman', displayName: 'Times New Roman', source: 'bundled' }
] as const;

interface FontStoreShape {
	fonts: FontEntry[];
	/** True while the user-fonts fetch is in flight. The dropdown
	 *  doesn't gate on this — bundled fonts are usable immediately. */
	loadingUserFonts: boolean;
	/** True once we've fetched at least once for the current session.
	 *  Used to avoid double-fetching in re-mounted editors. */
	userFontsLoaded: boolean;
}

function createFontStore() {
	const state = $state<FontStoreShape>({
		fonts: [...BUNDLED_FONTS],
		loadingUserFonts: false,
		userFontsLoaded: false
	});

	/** Track which user-font asset IDs we've already added to
	 *  document.fonts in this session — re-adding the same FontFace
	 *  shows up as a duplicate in document.fonts and confuses Fabric's
	 *  metric measurement. Plain object (Object.create(null)) keeps the
	 *  Svelte lint rule against mutable Set instances happy without
	 *  pulling in SvelteSet just for membership tracking. */
	const loadedIds: Record<string, true> = Object.create(null);

	function reset() {
		state.fonts = [...BUNDLED_FONTS];
		state.loadingUserFonts = false;
		state.userFontsLoaded = false;
		for (const k of Object.keys(loadedIds)) delete loadedIds[k];
	}

	async function loadUserFonts(): Promise<void> {
		// Browser-only — guard to keep SSR happy if anyone imports this
		// module from a server context.
		if (typeof document === 'undefined') return;
		if (state.loadingUserFonts) return;
		state.loadingUserFonts = true;
		try {
			const res = await fetch('/api/fonts');
			if (!res.ok) {
				// Non-fatal: dropdown keeps the bundled set, user just
				// can't pick uploaded fonts until they refresh. Logging
				// here helps when debugging mis-deployed envs.
				console.error('[fonts] /api/fonts failed', res.status);
				return;
			}
			const body = (await res.json()) as {
				items: { id: string; family: string; displayName: string; url: string }[];
			};

			// Add each not-yet-loaded font to document.fonts.
			const loadPromises: Promise<unknown>[] = [];
			for (const item of body.items) {
				if (loadedIds[item.id]) continue;
				loadedIds[item.id] = true;
				try {
					const face = new FontFace(item.family, `url(${JSON.stringify(item.url).slice(1, -1)})`);
					document.fonts.add(face);
					loadPromises.push(
						face.load().catch((err) => {
							// One bad font shouldn't kill the rest. Drop
							// the family from our list so the dropdown
							// doesn't offer a font that won't render.
							console.error('[fonts] FontFace.load failed', item.family, err);
							state.fonts = state.fonts.filter((f) => f.family !== item.family);
							return null;
						})
					);
				} catch (err) {
					console.error('[fonts] FontFace constructor failed', item.family, err);
				}
			}

			// Reconcile the visible list against the API response so a
			// font deleted elsewhere (other tab, /assets page) disappears
			// from the picker on the next editor open. We keep all
			// bundled entries plus exactly the user fonts the API still
			// reports — bundled entries are always present, and any
			// previously-shown user font that's no longer returned is
			// dropped (also clearing its loadedIds entry so a re-upload
			// can re-register).
			const apiFamilies = new Set(body.items.map((i) => i.family));
			const apiAssetIds = new Set(body.items.map((i) => i.id));
			const droppedAssetIds = Object.keys(loadedIds).filter(
				(id) => !apiAssetIds.has(id) && !id.startsWith('bundled:')
			);
			for (const id of droppedAssetIds) delete loadedIds[id];

			const nextFonts: FontEntry[] = [...BUNDLED_FONTS];
			for (const item of body.items) {
				if (!nextFonts.some((f) => f.family === item.family)) {
					nextFonts.push({
						family: item.family,
						displayName: item.displayName,
						source: 'user',
						url: item.url,
						assetId: item.id
					});
				}
			}
			// Preserve any stale entries that the FontFace.load catch
			// already removed (so we don't resurrect a known-broken
			// family). Stale = was in state.fonts but not in apiFamilies
			// AND was a user font.
			for (const f of state.fonts) {
				if (
					f.source === 'user' &&
					!apiFamilies.has(f.family) &&
					nextFonts.findIndex((nf) => nf.family === f.family) === -1
				) {
					// dropped — do not add back
					continue;
				}
			}
			state.fonts = nextFonts;

			await Promise.all(loadPromises);
			state.userFontsLoaded = true;
		} finally {
			state.loadingUserFonts = false;
		}
	}

	return {
		get fonts() {
			return state.fonts;
		},
		get loadingUserFonts() {
			return state.loadingUserFonts;
		},
		get userFontsLoaded() {
			return state.userFontsLoaded;
		},
		loadUserFonts,
		reset
	};
}

export const fontStore = createFontStore();
