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
	// Minify the runtime JS (strips comments, mangles locals, compacts
	// whitespace). The dts output is unaffected — types stay readable.
	// Required by TASK-227's size budget; the IDEA-203 spec calls for
	// <5KB min+gzip, and the un-minified output crept past 5KB at
	// TASK-224 from accumulated tsdoc comments in the runtime bundle.
	minify: true,
	// Preserve class + function names through minification. The error
	// classes' instance `.name` is explicitly set in each constructor,
	// but the *class* (`RateLimitError.name`) would otherwise be
	// mangled to `m` / `o` / etc., breaking debugger inspection and
	// any consumer that does `SomeErrorClass.name` (rare but valid).
	// Costs ~100 bytes gzipped; cheap insurance.
	esbuildOptions(options) {
		options.keepNames = true;
	},
	// Match the engines field — node 18+ supports es2022 natively, and
	// modern bundlers (Vite/Next/Edge) handle it as input without
	// further transpile.
	target: 'es2022'
});
