/**
 * forwardUrl resolution + http(s) scheme guard for the canvas-share routes.
 *
 * Originally inline in `src/routes/c/[slug]/+page.server.ts`. Extracted here
 * (TASK-165) so the upcoming `/i/{shortId}` share page can reuse the exact
 * same security boundary. Duplicating this logic would inevitably let the
 * two consumers drift on the scheme allowlist.
 *
 * SECURITY (TASK-92 Codex round 1, P1): the legacy server-side 302 was
 * immune to `javascript:`-scheme abuse because browsers don't execute
 * scripts in `Location` headers. Rendering the resolved URL as a clickable
 * `<a href>` on an interstitial is NOT immune — a creator could PATCH
 * `redirectUrl=javascript:alert(...)`, or smuggle it through a
 * `{{param}}` substitution, and the Continue CTA would execute script on
 * the app origin. Only emit the URL when its post-substitution scheme is
 * http(s). Anything else collapses to a non-ok result and the caller is
 * expected to render the landing without a CTA.
 */

/** Match a single `{{paramName}}` placeholder. Allows `[\w-]` so a
 *  user binding `utm-source` works the same as `utmSource`. */
const PARAM_PLACEHOLDER_RE = /\{\{([\w-]+)\}\}/g;

/** Replace `{{param}}` placeholders in a string with query parameter
 *  values. Missing keys substitute to empty string — the redirect /
 *  og:title contracts treat that as "user didn't provide a value", so
 *  the public URL doesn't 500 just because the creator added a
 *  placeholder for an unbound param. The caller can detect missing
 *  substitutions separately via {@link findUnsubstitutedPlaceholders}. */
export function substituteParams(template: string, params: Record<string, string>): string {
	// Regex literals carry lastIndex across .replace() calls when /g is set; in
	// practice .replace consumes it deterministically, but recreate a fresh
	// regex per call to be defensive against any future change in callers.
	const re = new RegExp(PARAM_PLACEHOLDER_RE.source, 'g');
	return template.replace(re, (_, key) => params[key] ?? '');
}

/** Return the list of `{{name}}` placeholders in `template` whose key
 *  is NOT present in `params`. Used to surface a structured warning
 *  log when the redirect-URL substitution is incomplete (TASK-96) so
 *  ops can spot misconfigured templates without parsing access logs.
 *  De-duped — a template referencing `{{user}}` twice surfaces once. */
export function findUnsubstitutedPlaceholders(
	template: string,
	params: Record<string, string>
): string[] {
	const missing = new Set<string>();
	const re = new RegExp(PARAM_PLACEHOLDER_RE.source, 'g');
	for (const match of template.matchAll(re)) {
		const key = match[1];
		if (!Object.hasOwn(params, key)) missing.add(key);
	}
	return [...missing];
}

export type ResolveForwardUrlResult =
	| { ok: true; url: string; unsubstituted: string[] }
	| {
			ok: false;
			reason: 'invalid-scheme' | 'unparseable';
			resolved: string;
			unsubstituted: string[];
	  };

/**
 * Canonical entrypoint for resolving a forwardUrl template against a
 * request's query params. Returns:
 *   - `null` when `rawTemplate` is null (no redirect configured)
 *   - `{ ok: true, url, unsubstituted }` for an http(s) URL — `unsubstituted`
 *     is non-empty when the template referenced placeholders the request
 *     didn't supply (caller decides whether to log)
 *   - `{ ok: false, reason: 'invalid-scheme', resolved, unsubstituted }`
 *     when post-substitution the URL has a non-http(s) scheme
 *   - `{ ok: false, reason: 'unparseable', resolved, unsubstituted }` when
 *     `new URL(resolved)` throws — typically a bare `{{param}}` template
 *     that didn't resolve, or input the publish form somehow accepted
 *     that isn't parseable
 *
 * Treat `unsubstituted` as advisory: substitution still happened (missing
 * keys collapse to empty), but a non-empty list is the signal ops use to
 * spot a misconfigured template.
 */
export function resolveForwardUrl(
	rawTemplate: string | null,
	params: Record<string, string>
): ResolveForwardUrlResult | null {
	if (rawTemplate === null) return null;
	const unsubstituted = findUnsubstitutedPlaceholders(rawTemplate, params);
	const resolved = substituteParams(rawTemplate, params);
	try {
		const parsed = new URL(resolved);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
			return { ok: true, url: resolved, unsubstituted };
		}
		return { ok: false, reason: 'invalid-scheme', resolved, unsubstituted };
	} catch {
		return { ok: false, reason: 'unparseable', resolved, unsubstituted };
	}
}
