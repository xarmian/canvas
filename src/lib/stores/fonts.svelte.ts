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
	family: string;
	source: 'bundled' | 'user';
	/** URL where the font can be loaded from (for user fonts). Bundled
	 *  fonts are served via system or @font-face in the page CSS and
	 *  don't need a URL surfaced here. */
	url?: string;
}

/** Bundled families. The renderer registers these via initDefaultFonts;
 *  the editor relies on the system or page-level @font-face to make
 *  them available client-side. Order roughly matches v0.1 frequency. */
export const BUNDLED_FONTS: readonly FontEntry[] = [
	{ family: 'Inter', source: 'bundled' },
	{ family: 'Arial', source: 'bundled' },
	{ family: 'Georgia', source: 'bundled' },
	{ family: 'Courier New', source: 'bundled' },
	{ family: 'Times New Roman', source: 'bundled' }
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
				items: { id: string; family: string; url: string }[];
			};

			// Add each not-yet-loaded font to document.fonts. We don't
			// await each load() — adding the FontFace makes its name
			// resolvable for Fabric's metric calls almost immediately,
			// and a missing render here is recoverable on the next
			// Fabric repaint. We do await Promise.all at the end so
			// callers can know "everything that's coming has arrived".
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
					// Surface immediately so the picker shows it.
					if (!state.fonts.some((f) => f.family === item.family)) {
						state.fonts = [...state.fonts, { family: item.family, source: 'user', url: item.url }];
					}
				} catch (err) {
					console.error('[fonts] FontFace constructor failed', item.family, err);
				}
			}

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
