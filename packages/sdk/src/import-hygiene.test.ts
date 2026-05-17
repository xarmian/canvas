/**
 * Import-hygiene guard.
 *
 * IDEA-203's "No Node-only deps" constraint says the SDK must work
 * on Cloudflare Workers / Vercel Edge / browsers without polyfills.
 * Two layers enforce that today:
 *
 * 1. **Build-time** — `tsup`'s `platform: 'neutral'` (see
 *    `tsup.config.ts`) fails the build if any node-only import
 *    sneaks into the source or a transitive dep.
 *
 * 2. **Source-scan** — this test. Reads every non-test `*.ts` file
 *    under `src/` and fails on forbidden patterns. Faster feedback
 *    than running `pnpm build` on every change, and the error
 *    message points at the exact file/line.
 *
 * Defense-in-depth on purpose — either guard would catch the
 * common case, but together they cover "I changed source but
 * forgot to rebuild" AND "the source looks fine but a dep dragged
 * Node in."
 *
 * Edge-runtime CI smoke (TASK-226) is the third layer — runs the
 * built bundle under wrangler / miniflare to catch anything the
 * two static checks miss.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `new URL(...).pathname` — Web URL API, works in modern Node without
// importing `node:url`. Avoids a `fileURLToPath` import that some
// `@types/node` versions don't surface cleanly under
// `verbatimModuleSyntax`.
const SRC_DIR = new URL('./', import.meta.url).pathname;

/** Recursively list all `.ts` files under `dir`. */
function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			out.push(...listTsFiles(path));
		} else if (name.endsWith('.ts')) {
			out.push(path);
		}
	}
	return out;
}

/** Source files only — test files are allowed to use anything (vitest, fs, etc.). */
function listSourceFiles(): string[] {
	return listTsFiles(SRC_DIR).filter((path) => !path.endsWith('.test.ts'));
}

/**
 * Forbidden module specifiers. Bare `node:*` imports are obvious;
 * the unprefixed names (`fs`, `path`, etc.) are flagged too because
 * node resolves them even without the `node:` prefix.
 */
const FORBIDDEN_MODULES = new Set([
	// `node:` prefix form
	'node:fs',
	'node:path',
	'node:os',
	'node:crypto',
	'node:child_process',
	'node:stream',
	'node:buffer',
	'node:worker_threads',
	'node:cluster',
	'node:http',
	'node:https',
	'node:net',
	'node:tls',
	'node:util',
	'node:process',
	'node:zlib',
	'node:fs/promises',
	'node:stream/promises',
	'node:perf_hooks',
	'node:async_hooks',
	'node:dns',
	// Unprefixed form. Node resolves these too, and they're a
	// flag-of-convenience for "bare specifier means node built-in"
	// even though some are technically polyfilled by bundlers. Reject
	// at the source so we never have to argue about the polyfill.
	'fs',
	'path',
	'os',
	'child_process',
	'stream',
	'buffer',
	'worker_threads',
	'cluster',
	'http',
	'https',
	'net',
	'tls',
	'util',
	'process',
	'zlib'
]);

/**
 * Match `import ... from 'spec'` AND `import 'spec'` AND
 * `import('spec')` (dynamic). Quotes single or double.
 */
const IMPORT_SPEC_RE =
	/(?:^|\s|;)import(?:[\s\w*{},]*from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Node-only global accesses. `process.env` and `Buffer` show up
 * idiomatically in node code; if either appears in source it means
 * something node-shaped slipped through review.
 */
const FORBIDDEN_GLOBALS = [
	{ pattern: /\bprocess\s*\./, name: 'process.*' },
	{ pattern: /\bBuffer\s*\./, name: 'Buffer.*' },
	{ pattern: /\bnew\s+Buffer\b/, name: 'new Buffer' },
	{ pattern: /\b__dirname\b/, name: '__dirname' },
	{ pattern: /\b__filename\b/, name: '__filename' }
];

describe('import hygiene — no Node-only deps in published SDK source', () => {
	const sourceFiles = listSourceFiles();

	it('found source files to scan', () => {
		// Defensive — if a path-resolution bug leaves us scanning
		// nothing, the test would falsely pass. Lock the floor at >0.
		expect(sourceFiles.length).toBeGreaterThan(0);
	});

	it.each(sourceFiles)('no forbidden module imports: %s', (path) => {
		const content = readFileSync(path, 'utf8');
		const matches: Array<{ spec: string; line: number }> = [];
		for (const match of content.matchAll(IMPORT_SPEC_RE)) {
			const spec = match[1] ?? match[2];
			if (spec === undefined) continue;
			if (FORBIDDEN_MODULES.has(spec)) {
				const before = content.slice(0, match.index ?? 0);
				const line = before.split('\n').length;
				matches.push({ spec, line });
			}
		}
		expect(matches, `node-only imports in ${path}: ${JSON.stringify(matches)}`).toEqual([]);
	});

	it.each(sourceFiles)('no forbidden globals: %s', (path) => {
		const content = readFileSync(path, 'utf8');
		// Strip line + block comments so doc references to `process.env`
		// in tsdoc don't trip the regex.
		const stripped = content
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/[^\n]*/g, '');
		const hits = FORBIDDEN_GLOBALS.filter((g) => g.pattern.test(stripped));
		expect(
			hits.map((h) => h.name),
			`node-only globals in ${path}`
		).toEqual([]);
	});
});
