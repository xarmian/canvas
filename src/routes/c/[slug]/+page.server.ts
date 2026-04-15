import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

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
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
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

	// Build image URL with all params forwarded
	const imageParams = new URLSearchParams(queryParams).toString();
	const imageUrl = `${url.origin}/c/${canvas.slug}/image.png${imageParams ? `?${imageParams}` : ''}`;

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
