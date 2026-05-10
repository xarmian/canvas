/**
 * Shared param-name validation helpers (TASK-106).
 *
 * Three places in the editor reference URL-parameter names:
 *  1. Conditional-style rule editor (PropertyPanel) — `rule.when.param`.
 *  2. Redirect URL `{{name}}` placeholders (PublishModal).
 *  3. Test-Parameters preview rows in the editor route.
 *
 * Each used to roll its own "is this name known?" check, and only the
 * live runtime would surface a typo (`gainPct` typed against a binding
 * named `gainPercent` silently no-ops). This module is the single
 * source of truth so all three flag the same set of typos identically
 * and offer the same suggestion when one exists.
 *
 * The Levenshtein implementation is intentionally tiny — it runs at
 * design time on inputs measured in dozens of characters. No need for
 * the rolling-2-row optimization or the SIMD tricks; the canonical
 * O(n*m) DP table is plenty fast and easy to reason about.
 */

/** Standard edit-distance (insert/delete/substitute, each cost 1).
 *  Returns 0 for identical inputs, max(a.length, b.length) for two
 *  totally disjoint strings. Stable across re-runs (no early exits
 *  that depend on input order). */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	// `prev` / `curr` rolling rows — same logic as the textbook DP
	// table but only one row of memory. The table-based version
	// would be ~6x as much code with no measurable speed benefit at
	// these input sizes.
	const aLen = a.length;
	const bLen = b.length;
	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) prev[j] = j;
	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		for (let j = 1; j <= bLen; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			// min of (delete, insert, substitute)
			const del = prev[j] + 1;
			const ins = curr[j - 1] + 1;
			const sub = prev[j - 1] + cost;
			curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
		}
		// Swap rows for the next iteration. Reusing the old `prev`
		// array keeps allocations off the hot path even though the
		// caller is unlikely to spam this function.
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return prev[bLen];
}

/** Return the closest entry in `candidates` to `target` whose edit
 *  distance is within an "obvious typo" threshold. The threshold
 *  scales with target length (`max(1, floor(len/3))`) so a 4-char
 *  name accepts distance 1 (one transposition) while a 12-char name
 *  accepts distance 4 (a couple of slips). Returns null when nothing
 *  is close enough — better than always offering a wild suggestion
 *  that bears no relation to the user's intent. */
export interface SuggestionResult {
	name: string;
	distance: number;
}

export function nearestParamName(
	target: string,
	candidates: readonly string[]
): SuggestionResult | null {
	if (!target) return null;
	if (candidates.length === 0) return null;
	const threshold = Math.max(1, Math.floor(target.length / 3));
	let best: SuggestionResult | null = null;
	for (const name of candidates) {
		if (!name || name === target) continue;
		const d = levenshtein(target, name);
		if (d > threshold) continue;
		if (!best || d < best.distance) {
			best = { name, distance: d };
		}
	}
	return best;
}

/** High-level reference status for a single name lookup, packaging
 *  the "is it known?" answer with the optional suggestion in one
 *  shot. Callers render a warning chip iff `kind === 'unknown'`,
 *  and append the suggestion when it's set.
 *
 *  `kind === 'empty'` distinguishes "user hasn't typed anything yet"
 *  from "user typed something we don't recognize" — the empty state
 *  shouldn't render a warning, but is a useful hint when callers
 *  want to render placeholder copy. */
export type ParamRefStatus =
	| { kind: 'empty' }
	| { kind: 'known' }
	| { kind: 'unknown'; suggestion: string | null };

export function paramRefStatus(name: string, knownNames: readonly string[]): ParamRefStatus {
	// `kind === 'empty'` allows whitespace-only too — the rule editor's
	// initial "user hasn't started typing" state shouldn't render a
	// warning even if the input has stray whitespace from a paste.
	if (!name.trim()) return { kind: 'empty' };
	// Don't trim before the membership check: the renderer resolves
	// `params[rule.when.param]` verbatim, so `gainPercent ` (trailing
	// space) is a real mismatch even if `gainPercent` exists. Marking
	// it `known` would hide a typo the user can't otherwise see.
	// Codex round 1 P2.
	if (knownNames.includes(name)) return { kind: 'known' };
	const match = nearestParamName(name, knownNames);
	return { kind: 'unknown', suggestion: match?.name ?? null };
}
