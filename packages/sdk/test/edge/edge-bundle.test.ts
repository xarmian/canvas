/**
 * Edge-runtime bundle smoke test (TASK-226).
 *
 * Acceptance criterion #3 from IDEA-203: the SDK must build into a
 * Cloudflare Workers / Vercel Edge function bundle without
 * polyfills. This test programmatically bundles `worker.ts` (a
 * minimal handler that calls every public method on `CanvasClient`)
 * with esbuild configured to match workerd's posture, and asserts:
 *
 *   1. The bundle BUILDS — no unresolved `node:*` imports, no
 *      polyfill demands, no compile errors.
 *   2. The OUTPUT carries no `node:*` strings, even from transitive
 *      deps. The source-level hygiene scan (TASK-225) covers our
 *      own files; this catches anything that sneaks in through a
 *      dep update.
 *   3. The published `dist/index.js` (when present) is also free of
 *      `node:*` references. Defense in depth — tsup already builds
 *      with `platform: 'neutral'`, but verifying the actual artifact
 *      that ships to npm is the strongest guarantee.
 *
 * Layered defense across TASK-225/226:
 *
 *   - Source scan      (TASK-225, import-hygiene.test.ts)
 *   - Build config     (TASK-225, tsup `platform: 'neutral'`)
 *   - Bundle smoke     (this test) — esbuild with workerd config
 *   - Artifact scan    (this test) — grep the published bundle
 */
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const WORKER_ENTRY = new URL('./worker.ts', import.meta.url).pathname;
const DIST_ESM = new URL('../../dist/index.js', import.meta.url).pathname;

/**
 * Build the worker entry with workerd-compatible esbuild settings.
 * - `platform: 'browser'` — esbuild treats `node:*` as unresolvable.
 * - `format: 'esm'` — workerd modules format.
 * - `conditions: ['worker', 'browser']` — picks worker exports
 *   from package.json conditional exports if a dep ever defines them.
 * - `external: []` — no externals tolerated; everything must bundle.
 */
async function bundleWorker(): Promise<string> {
	const result = await build({
		entryPoints: [WORKER_ENTRY],
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'esm',
		target: 'es2022',
		conditions: ['worker', 'browser'],
		minify: false,
		logLevel: 'silent'
	});
	const file = result.outputFiles[0];
	if (file === undefined) throw new Error('esbuild produced no output');
	return file.text;
}

describe('edge-runtime smoke (TASK-226)', () => {
	it('worker.ts bundles successfully under workerd-compatible config', async () => {
		// If esbuild throws, the test fails with the underlying
		// "Could not resolve 'node:fs'" (or similar) message — that
		// IS the assertion. We catch + re-throw with a friendlier
		// header so future regressions are obvious.
		let bundle: string;
		try {
			bundle = await bundleWorker();
		} catch (err) {
			throw new Error(
				`Edge bundle failed — the SDK is pulling in something edge-incompatible: ${
					(err as Error).message
				}`
			);
		}
		expect(bundle.length).toBeGreaterThan(0);
	});

	it('bundled worker output contains no `node:` module specifiers', async () => {
		const bundle = await bundleWorker();
		// Look for any `node:` prefix in the bundle. Include the
		// trailing word boundary to avoid matching something like
		// `someNode:` (unlikely but cheap to guard). Comments would
		// have been stripped by minify in the real build pipeline
		// but we keep the test bundle unminified for readable
		// failures, so we still guard against false-positives by
		// requiring the colon to be followed by a known node
		// builtin name.
		const matches = bundle.match(
			/\bnode:(fs|path|os|crypto|child_process|stream|buffer|worker_threads|cluster|http|https|net|tls|util|process|zlib|fs\/promises|stream\/promises|perf_hooks|async_hooks|dns)\b/g
		);
		expect(matches, `Found node:* specifiers in edge bundle: ${matches}`).toBeNull();
	});

	it('published dist/index.js contains no `node:` module specifiers', () => {
		// dist/ is only present after `pnpm build`. Skip when it
		// isn't there — the CI workflow runs build before test, so
		// the check exercises the real artifact in CI. Local runs
		// without a build skip cleanly.
		if (!existsSync(DIST_ESM)) {
			return;
		}
		const content = readFileSync(DIST_ESM, 'utf8');
		const matches = content.match(
			/\bnode:(fs|path|os|crypto|child_process|stream|buffer|worker_threads|cluster|http|https|net|tls|util|process|zlib|fs\/promises|stream\/promises|perf_hooks|async_hooks|dns)\b/g
		);
		expect(
			matches,
			`Found node:* specifiers in published bundle: ${matches}`
		).toBeNull();
	});
});
