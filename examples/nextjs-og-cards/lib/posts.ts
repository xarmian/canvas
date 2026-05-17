/**
 * Fixture blog posts. No DB — the point of the example is the OG
 * image pipeline, not a real CMS.
 */
export interface Post {
	slug: string;
	title: string;
	subtitle: string;
	author: string;
	body: string;
}

export const posts: Post[] = [
	{
		slug: 'hello-world',
		title: 'Hello, world',
		subtitle: 'A first post on a dynamic OG image pipeline',
		author: 'Jane Doe',
		body: 'This is a minimal Next.js 14 example demonstrating dynamic OG images via @canvas-images/sdk. Each post gets its own OG card built from the post metadata at request time — zero pre-rendered images, infinite variants.'
	},
	{
		slug: 'edge-rendering',
		title: 'Edge-rendering OG images',
		subtitle: 'Why the SDK ships node-free',
		author: 'Sam Smith',
		body: 'The SDK is built to run on Cloudflare Workers, Vercel Edge, browsers — anywhere fetch + URL exist. No node:* imports, no polyfills required.'
	},
	{
		slug: 'rate-limit-budget',
		title: 'A rate-limit budget you can actually catch',
		subtitle: '`client.lastRateLimit` after every response',
		author: 'Alex Lee',
		body: 'Stripe-style rate-limit headers, surfaced on the client without re-parsing in your catch blocks. Plus an auto-retry on transient 429s that knows not to retry quota errors.'
	}
];

export function getPost(slug: string): Post | undefined {
	return posts.find((p) => p.slug === slug);
}
