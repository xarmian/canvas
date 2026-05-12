/**
 * Public canvas share route — `/c/{slug}`.
 *
 * URL scheme (chosen for v1 in TASK-92):
 *   - Globally-unique user-chosen slug. One creator's "lp-card" excludes
 *     anyone else's "lp-card". Collisions on auto-derived slugs (POST
 *     /api/canvas, duplicate) resolve by appending the smallest free
 *     `-N` suffix; user-driven rename (PATCH, TASK-98) returns 409 with
 *     a suggested alternative so the UI can offer one-click acceptance.
 *   - No `-{nanoid}` suffix on auto-derived slugs (drop from v0.4 scheme).
 *   - No back-compat redirect when a slug is renamed; the old URL 404s.
 *     Pre-launch latitude (PLAN-81) — no live URLs to preserve.
 *
 * Alternative URL schemes considered:
 *   - `/c/{username}/{slug}` — slugs unique per user. Rejected because
 *     v1 wants the cleanest possible URL on social-share copy/paste,
 *     and user-namespacing forces an extra path segment (and a username
 *     onboarding decision) that isn't worth the disambiguation benefit.
 *   - Opaque `/c/{id}` with optional `/c/{slug}` alias. Rejected as more
 *     plumbing for a marginal flexibility gain we can add later if the
 *     global namespace gets contentious.
 *   - Status-quo `/c/{name}-{nanoid}` with rename support. Rejected
 *     because the nanoid suffix is dead weight on every share URL —
 *     and renaming a slug-with-nanoid still produces an aesthetically
 *     ugly URL.
 *
 * See `src/lib/server/slug.ts` for the format rules and uniqueness
 * resolver this route depends on.
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { resolveContentVersion } from '$lib/server/content-version';
import { substituteParams, resolveForwardUrl } from '$lib/server/forward-url';

export const load: PageServerLoad = async ({ params, url }) => {
	// Load canvas by slug (must be published)
	const [canvas] = await db.select().from(canvases).where(eq(canvases.slug, params.slug));

	if (!canvas || !canvas.published) {
		error(404, 'Canvas not found');
	}

	// Collect query params
	const queryParams: Record<string, string> = {};
	for (const [key, value] of url.searchParams) {
		queryParams[key] = value;
	}

	// TASK-93: append `_v=<contentVersionToken>` to the og:image URL so
	// social caches (Twitter / Bluesky / Discord / Slack / LinkedIn)
	// auto-invalidate after a canvas edit. The token derivation lives
	// in `$lib/server/content-version.ts` — see that file for the
	// "what inputs change the token" contract. Same token is what the
	// render route's immutable-cache opt-in checks against, so embed
	// snippets keep working unchanged.
	//
	// `_v` is added to the og:image URL ONLY (not to the canonical
	// share URL the user copies). Putting it in the share URL itself
	// would be churn-y — the user would have to re-copy after every
	// edit. Cards refresh because crawlers follow the `og:image` meta,
	// which we control on every render.
	// Pass templateJson so the asset-set fingerprint folds into the
	// token (TASK-117). Asset deletes/replacements roll `_v` even
	// when the canvas itself wasn't edited, so social-CDN caches
	// drop the stale resolved render.
	const versionToken = await resolveContentVersion(
		canvas.updatedAt,
		canvas.userId,
		(canvas.templateJson as unknown as import('$lib/engine').FabricCanvasJson | null) ?? null
	);
	const imageQuery = new URLSearchParams(queryParams);
	imageQuery.set('_v', versionToken);
	const imageUrl = `${url.origin}/c/${canvas.slug}/image.png?${imageQuery.toString()}`;

	// OG metadata with param substitution
	const ogTitle = canvas.ogTitle ? substituteParams(canvas.ogTitle, queryParams) : canvas.name;
	const ogDescription = canvas.ogDescription
		? substituteParams(canvas.ogDescription, queryParams)
		: `Created with Canvas`;

	// Resolve the redirect destination (post-substitution) when one is
	// configured. We render an explicit "Continue to {host}" CTA on the
	// landing rather than auto-302'ing humans (TASK-139). Two reasons:
	//
	//   1. The most-trafficked path is a tap from a mobile social app.
	//      An instant 302 shows a brief Canvas-branded flash before
	//      bouncing, which reads as sketchy / loading-failure. A
	//      branded interstitial with the visible destination host
	//      reassures the user that the link is going where they expect.
	//
	//   2. Bots already skip the redirect — they need the landing for
	//      OG meta scrape. Removing the user-agent branch keeps the
	//      response shape uniform and removes a UA-sniffing path.
	//
	// Substitution still folds `{{param}}` placeholders into the URL
	// using the request's query params, and we still emit the warning
	// log when a placeholder isn't satisfied (TASK-96) — that signal is
	// useful regardless of whether the redirect is auto or interstitial.
	//
	// SECURITY: the legacy server-side 302 was immune to `javascript:` abuse
	// because browsers don't execute scripts in `Location` headers. The
	// interstitial's clickable `<a href>` is NOT immune, so we only emit the
	// URL when its post-substitution scheme is http(s). Anything else
	// collapses to `null` and the landing renders without a CTA — same
	// fallback the no-redirect case uses, so layout is unchanged. The
	// allowlist + warning logs live in `$lib/server/forward-url.ts` so the
	// /i/{shortId} share page can reuse the exact same boundary (TASK-165).
	let redirectUrl: string | null = null;
	const fwd = resolveForwardUrl(canvas.redirectUrl, queryParams);
	if (fwd?.unsubstituted.length) {
		console.warn(
			`[redirect] unsubstituted placeholders slug=${canvas.slug} missing=${fwd.unsubstituted.join(',')}`
		);
	}
	if (fwd?.ok) {
		redirectUrl = fwd.url;
	} else if (fwd?.ok === false) {
		if (fwd.reason === 'invalid-scheme') {
			// `invalid-scheme` only happens when `new URL(resolved)` succeeded,
			// so re-parsing is safe and gives us `URL.protocol` for the same
			// log shape the inline implementation emitted before extraction.
			const scheme = new URL(fwd.resolved).protocol;
			console.warn(`[redirect] dropped non-http(s) scheme slug=${canvas.slug} scheme=${scheme}`);
		} else {
			console.warn(
				`[redirect] unparseable resolved URL slug=${canvas.slug} raw=${canvas.redirectUrl}`
			);
		}
	}

	// Canonical share URL emitted as `og:url` (TASK-97). Strips the
	// `_v` query token and any underscore-prefixed flags so the
	// canonical reflects the user-typed URL, not the auto-versioned
	// one we emit on og:image. Query params the user did pass through
	// (e.g. ?title=...) are preserved so the canonical for a
	// parameterized share page distinguishes from the bare canvas page.
	const canonicalQuery = new URLSearchParams();
	for (const [key, value] of Object.entries(queryParams)) {
		if (key.startsWith('_')) continue;
		canonicalQuery.set(key, value);
	}
	const canonicalShareUrl = `${url.origin}/c/${canvas.slug}${
		canonicalQuery.size ? `?${canonicalQuery.toString()}` : ''
	}`;

	return {
		canvas: {
			name: canvas.name,
			slug: canvas.slug,
			width: canvas.width,
			height: canvas.height
		},
		imageUrl,
		canonicalShareUrl,
		ogTitle,
		ogDescription,
		redirectUrl,
		queryParams
	};
};
