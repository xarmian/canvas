/**
 * Shared param-value coercion helpers.
 *
 * Lives outside renderer.ts and conditionals.ts so both can reuse the same
 * lenient string→bool semantics without creating a circular import (renderer
 * already imports from conditionals).
 */

/**
 * Lenient boolean coercion for URL-param-style strings.
 *
 * - `'true'`/`'1'`/`'yes'`/`'on'` → `true`
 * - `'false'`/`'0'`/`'no'`/`'off'`/`''` (empty string) → `false`
 * - Any other input → `undefined` (so callers can preserve the prior value
 *   instead of forcing `false`).
 *
 * The empty-string-as-false is intentional: a URL like `?boosted=` should
 * read as "explicitly off" rather than fall back to the binding default.
 */
export function coerceBoolean(value: string): boolean | undefined {
	const v = value.trim().toLowerCase();
	if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
	if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === '') return false;
	return undefined;
}
