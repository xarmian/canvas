/**
 * Minimal Cloudflare Workers / Vercel Edge entry that exercises the
 * SDK's public surface against an edge-only environment (no Node
 * globals, no node:* imports tolerated by the bundle pipeline).
 *
 * Used by:
 *
 * - `edge-bundle.test.ts` — bundles this file via esbuild with
 *   workerd-compatible config and asserts the output is free of
 *   `node:*` references.
 * - Manually with wrangler (`wrangler dev test/edge/worker.ts`) if
 *   anyone wants to smoke-test against the actual workerd runtime.
 *
 * The handler doesn't try to be useful — it just calls every
 * roundtrip method on `CanvasClient` so the bundler is forced to
 * pull every code path. `bake()` etc. will fail at runtime when
 * fetch isn't pointed at a real Canvas instance, but that's not
 * what this test is verifying: this test verifies the BUNDLE is
 * edge-safe.
 */

import { CanvasClient } from '../../src/index.js';

// Cloudflare Workers' fetch-handler shape. Typing it inline avoids
// pulling in @cloudflare/workers-types as a devDep for one file.
type FetchHandler = {
	fetch(request: Request): Response | Promise<Response>;
};

const client = new CanvasClient({
	baseUrl: 'https://canvas.example.com',
	apiKey: 'sk_test_edge_smoke'
});

const handler: FetchHandler = {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Sync URL builder — exercises image() + URLSearchParams +
		// encodeURIComponent. No network.
		const imageUrl = client.image('og-card', { title: 'Hello from edge' });

		// Authenticated read — exercises request() wrapper +
		// throwFromResponse + parseRateLimitHeaders + retry loop.
		// fetch() against canvas.example.com will fail in the actual
		// workerd runtime; that's fine. The bundle pulling the code
		// path is what matters.
		if (url.searchParams.get('exercise') === 'all') {
			try {
				await client.list({ limit: 10 });
				await client.get('abcdef1234');
				await client.delete('abcdef1234');
				await client.bake('og-card', { title: 'Hello' });
			} catch {
				/* expected — example.com doesn't resolve */
			}
		}

		return new Response(imageUrl, { headers: { 'Content-Type': 'text/plain' } });
	}
};

export default handler;
