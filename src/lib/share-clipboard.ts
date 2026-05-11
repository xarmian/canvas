/**
 * Canonical clipboard helper for "Copy share URL" / "Copy image URL"
 * actions surfaced across the app.
 *
 * Before TASK-132 each surface (editor toolbar, PublishModal,
 * dashboard card menu) reimplemented this in slightly different ways:
 * different fallback paths, different success/error wording, one
 * surface missing the legacy `<textarea>+execCommand` fallback
 * altogether. Consolidating here means:
 *
 *   1. One place to fix bugs (a clipboard quirk surfaced by a new
 *      WebView only needs to be patched once).
 *   2. One place to evolve error copy when we learn what reads best.
 *   3. Callers stay focused on their UX — they pass the success
 *      message that names what was copied; the failure path is
 *      canonical because the recovery action ("select text and copy
 *      manually") is the same regardless of which surface invoked it.
 *
 * The returned boolean lets callers branch their UI on success —
 * e.g., dashboard suppresses a transient "Copied!" badge animation
 * when copy failed.
 */
import { toast } from '$lib/stores/toast.svelte';

/**
 * Write `text` to the clipboard. Falls back to the legacy
 * `<textarea>` + `document.execCommand('copy')` path on clients that
 * disable `navigator.clipboard` (locked-down corporate WebViews,
 * certain in-app browsers, older Safari). Surfaces success / failure
 * as a toast.
 *
 * MUST be called from a user-gesture handler (click, keydown) —
 * browsers gate clipboard writes on user activation, so calling this
 * from a setTimeout or async-after-await context can fail
 * unpredictably depending on browser.
 *
 * @param text     The content to write to the clipboard.
 * @param opts.success  The success-toast message. Should name what
 *                      was copied (e.g. "Share URL copied",
 *                      `Image URL for "${name}" copied`).
 * @returns `true` on success, `false` if both the async API and the
 *          fallback path failed.
 */
export async function copyToClipboard(text: string, opts: { success: string }): Promise<boolean> {
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
		} else if (!fallbackCopy(text)) {
			// Fallback path ran but the legacy API reported failure
			// (some hardened WebViews accept `execCommand` but no-op
			// it). Route through the same failure UX as a thrown
			// exception so users get the recovery hint instead of a
			// false "copied" confirmation.
			throw new Error('execCommand("copy") returned false');
		}
		toast.success(opts.success);
		return true;
	} catch {
		// Either the user rejected the clipboard permission prompt,
		// the API threw (insecure context, mid-render call, etc.), or
		// the legacy fallback reported failure. Either way the text
		// didn't make it to the clipboard, so surface a recovery hint
		// instead of silently no-oping.
		toast.error("Couldn't copy to clipboard. Select the text and copy manually.");
		return false;
	}
}

/**
 * Legacy fallback: synthesize a hidden textarea, select it, and use
 * the (deprecated but still ubiquitous) `document.execCommand('copy')`.
 * Skipping this path leaves the button as a silent no-op on WebViews
 * that disable the async clipboard API.
 *
 * The cleanup is in `finally` so a throw during `select()` /
 * `execCommand` (e.g. an extension synchronously cancels the copy)
 * still removes the temporary node from the DOM. `execCommand` itself
 * returns `false` rather than throwing when the copy was blocked, so
 * the caller checks the returned boolean.
 */
function fallbackCopy(text: string): boolean {
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.position = 'fixed';
	ta.style.left = '-9999px';
	document.body.appendChild(ta);
	try {
		ta.select();
		return document.execCommand('copy');
	} finally {
		document.body.removeChild(ta);
	}
}
