/**
 * size-limit config — enforces the IDEA-203 budget in CI.
 *
 * IDEA-203 calls for **<5KB min+gzip** for the "core" (`client.image`
 * only) path and a "reasonable" budget for the full client. Because
 * the SDK is class-based, tree-shaking cannot drop unused methods
 * from `CanvasClient` — verified at TASK-227 time, the
 * image-only and full bundles round-trip within 3 bytes of each
 * other under esbuild+rollup with `sideEffects: false`. So the
 * "core" measurement is currently identical to "full"; both budgets
 * sit at the same ceiling.
 *
 * If we ever want a tighter "core" budget, the path is to extract
 * `image()` into a standalone exported function (or split into a
 * separate `@canvas-images/sdk/image` subpath export). Tracked as
 * a follow-up — not blocking v1.
 */
module.exports = [
	{
		name: 'CanvasClient (full surface)',
		// `tsup` already minifies + tree-shakes the published bundle;
		// size-limit re-bundles to measure what a consumer's app
		// would actually ship.
		path: 'dist/index.js',
		limit: '5 KB',
		// Run with brotli too — many CDNs serve brotli by default for
		// modern clients and it's the more honest "what the user
		// actually downloads" figure. size-limit reports both.
		brotli: true,
		gzip: true
	},
	{
		name: 'CanvasClient — image() only (sync URL builder path)',
		// Same artifact, custom-import path: measures what a consumer
		// who only ever calls `client.image()` would ship. Today this
		// matches the full surface (class methods can't be dropped by
		// tree-shaking), but locks the budget in so a future
		// refactor that splits the image path can measurably
		// demonstrate the win.
		path: 'dist/index.js',
		import: '{ CanvasClient }',
		limit: '5 KB',
		brotli: true,
		gzip: true
	}
];
