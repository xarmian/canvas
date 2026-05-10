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
import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { resolveContentVersion } from '$lib/server/content-version';

const BOT_USER_AGENTS = [
	'twitterbot',
	'facebookexternalhit',
	'linkedinbot',
	'slackbot',
	'discordbot',
	'telegrambot',
	'whatsapp',
	'googlebot',
	'bingbot',
	'yandexbot',
	'baiduspider',
	'duckduckbot',
	'embedly',
	'quora link preview',
	'showyoubot',
	'outbrain',
	'pinterestbot',
	'applebot',
	'redditbot',
	'rogerbot',
	'vkshare',
	'w3c_validator',
	'tumblr',
	'skypeuripreview'
];

function isBot(userAgent: string): boolean {
	const ua = userAgent.toLowerCase();
	return BOT_USER_AGENTS.some((bot) => ua.includes(bot));
}

/** Replace {{param}} placeholders in a string with query parameter values */
function substituteParams(template: string, params: Record<string, string>): string {
	return template.replace(/\{\{([\w-]+)\}\}/g, (_, key) => params[key] ?? '');
}

export const load: PageServerLoad = async ({ params, url, request }) => {
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
	const versionToken = await resolveContentVersion(canvas.updatedAt, canvas.userId);
	const imageQuery = new URLSearchParams(queryParams);
	imageQuery.set('_v', versionToken);
	const imageUrl = `${url.origin}/c/${canvas.slug}/image.png?${imageQuery.toString()}`;

	// OG metadata with param substitution
	const ogTitle = canvas.ogTitle ? substituteParams(canvas.ogTitle, queryParams) : canvas.name;
	const ogDescription = canvas.ogDescription
		? substituteParams(canvas.ogDescription, queryParams)
		: `Created with Canvas`;

	// Check if this is a bot/crawler
	const userAgent = request.headers.get('user-agent') ?? '';

	if (!isBot(userAgent)) {
		// Human visitor — redirect to configured destination or show landing page
		if (canvas.redirectUrl) {
			const redirectTo = substituteParams(canvas.redirectUrl, queryParams);
			redirect(302, redirectTo);
		}
		// No redirect configured — fall through to landing page
	}

	return {
		canvas: {
			name: canvas.name,
			slug: canvas.slug,
			width: canvas.width,
			height: canvas.height
		},
		imageUrl,
		ogTitle,
		ogDescription,
		queryParams
	};
};
