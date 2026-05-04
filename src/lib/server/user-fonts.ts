/**
 * User-uploaded font registration.
 *
 * Fonts uploaded via /api/upload are stored as `assets` rows but are
 * not registered with the Skia renderer until they're needed. This
 * module owns the lazy-load: on render, the route handler calls
 * `ensureUserFontsRegistered(userId)` which downloads any not-yet-
 * registered font for that user and hands it to GlobalFonts.
 *
 * Registration is process-global (GlobalFonts is a singleton), so we
 * only need to track which asset IDs we've already registered to skip
 * redundant storage fetches. Cleared via `forgetUserFontRegistration`
 * when an asset is deleted, so a re-uploaded file with the same
 * derived family name doesn't keep serving the old bytes.
 */
import { db } from './db';
import { assets } from './db/schema';
import { eq, and, or, like } from 'drizzle-orm';
import { getStorage, ALLOWED_FONT_TYPES } from './storage';
import { registerFontFromBuffer } from '$lib/engine';

/** Asset IDs that have been handed to GlobalFonts.register() in this
 *  process. Keeps us from repeatedly downloading + re-registering the
 *  same font on every render. */
const registered = new Set<string>();

/**
 * Strip a recognized font extension from a filename and return the
 * remainder as the family name. Falls back to the full filename if
 * no extension is recognized. Trims whitespace and collapses common
 * separators so "MyFont-Regular.ttf" → "MyFont-Regular". Multi-weight
 * support (recognizing "-Bold" and registering under the same family)
 * is deferred — users who want it can rename their files to match.
 */
export function deriveFontFamily(filename: string): string {
	const trimmed = filename.trim();
	// Recognized font extensions, longest-first so .woff2 isn't truncated to .woff.
	const exts = ['.woff2', '.woff', '.otf', '.ttf'];
	const lower = trimmed.toLowerCase();
	for (const ext of exts) {
		if (lower.endsWith(ext)) {
			return trimmed.slice(0, -ext.length) || trimmed;
		}
	}
	return trimmed;
}

/**
 * Namespace a user's derived family name with their user id so two
 * users (or the same user with re-uploads under a different file
 * name) can't collide in the process-global GlobalFonts registry.
 * The display name shown in the picker is still the un-namespaced
 * derived family — the namespaced form is what gets stored in
 * templateJson and resolved by the renderer.
 */
export function scopedFontFamily(userId: string, derivedFamily: string): string {
	return `u-${userId}__${derivedFamily}`;
}

/** Build a Drizzle WHERE for "is a font asset" (matches our two
 *  ALLOWED_FONT_TYPES MIME shapes — `font/*` and `application/x-font-*` /
 *  `application/font-*`). Kept here so /api/fonts and this loader stay
 *  in sync. */
export function fontAssetWhere() {
	return or(
		like(assets.contentType, 'font/%'),
		like(assets.contentType, 'application/x-font-%'),
		like(assets.contentType, 'application/font-%')
	);
}

interface FontRow {
	id: string;
	storageKey: string;
	filename: string;
}

async function loadFontRows(userId: string): Promise<FontRow[]> {
	return db
		.select({
			id: assets.id,
			storageKey: assets.storageKey,
			filename: assets.filename
		})
		.from(assets)
		.where(and(eq(assets.userId, userId), fontAssetWhere()));
}

/**
 * Return the set of currently-alive user font families for `userId`,
 * each in scoped form. The render endpoint uses this to swap any
 * fontFamily references in templateJson that point to a deleted
 * font — without that, a canvas keeps drawing with the deleted
 * font's bytes until the server process restarts (GlobalFonts has
 * no unregister API).
 */
export async function getLiveUserFontFamilies(userId: string): Promise<Set<string>> {
	const rows = await loadFontRows(userId);
	return new Set(rows.map((r) => scopedFontFamily(userId, deriveFontFamily(r.filename))));
}

/**
 * Download and register every font asset belonging to `userId` that
 * hasn't already been registered in this process. Best-effort: a
 * failure on one font is logged and skipped so it can't block a
 * render that doesn't use that font.
 */
export async function ensureUserFontsRegistered(userId: string): Promise<void> {
	const rows = await loadFontRows(userId);
	const pending = rows.filter((r) => !registered.has(r.id));
	if (pending.length === 0) return;

	const storage = getStorage();
	await Promise.all(
		pending.map(async (row) => {
			try {
				const buffer = await storage.read(row.storageKey);
				registerFontFromBuffer(buffer, scopedFontFamily(userId, deriveFontFamily(row.filename)));
				registered.add(row.id);
			} catch (err) {
				console.error('[user-fonts] failed to register', {
					assetId: row.id,
					filename: row.filename,
					err
				});
			}
		})
	);
}

/** Clear the in-process registration tracking for a single asset.
 *  Called after asset deletion so a future re-upload with the same
 *  derived family name doesn't serve from the old GlobalFonts entry.
 *  Note: GlobalFonts has no unregister API, so the prior bytes still
 *  live in Skia's font cache for the rest of the process — but with
 *  the asset row gone, no future render will reference its family. */
export function forgetUserFontRegistration(assetId: string): void {
	registered.delete(assetId);
}

/** Re-export so callers don't have to import from storage just to
 *  filter their own queries. */
export { ALLOWED_FONT_TYPES };
