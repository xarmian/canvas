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
		} else {
			// Legacy fallback: synthesize a hidden textarea, select it,
			// and use the (deprecated but still ubiquitous)
			// `document.execCommand('copy')`. Skipping this path leaves
			// the button as a silent no-op on WebViews that disable the
			// async clipboard API — the recovery hint in the catch
			// branch wouldn't even fire because the call wouldn't throw,
			// it just wouldn't exist.
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.setAttribute('readonly', '');
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
		}
		toast.success(opts.success);
		return true;
	} catch {
		// Either the user rejected the clipboard permission prompt or
		// the API threw (insecure context, mid-render call, etc.).
		// Either way the text didn't make it to the clipboard, so
		// surface a recovery hint instead of silently no-oping.
		toast.error("Couldn't copy to clipboard. Select the text and copy manually.");
		return false;
	}
}
