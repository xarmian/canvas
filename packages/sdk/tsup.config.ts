import { defineConfig } from 'tsup';

export default defineConfig({
	// Explicit entry list — tests live alongside source under src/*.test.ts
	// and must not ship in the tarball.
	entry: ['src/index.ts'],
	// Dual format. `type: module` in package.json makes .js the ESM
	// output and .cjs the CJS output, lining up with the `exports` map.
	format: ['esm', 'cjs'],
	outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
	// Emit .d.ts (for ESM) and .d.cts (for CJS) so the exports map's
	// per-format `types` conditions resolve cleanly under TS
	// moduleResolution: bundler / node16.
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	// Match the engines field — node 18+ supports es2022 natively, and
	// modern bundlers (Vite/Next/Edge) handle it as input without
	// further transpile.
	target: 'es2022'
});
