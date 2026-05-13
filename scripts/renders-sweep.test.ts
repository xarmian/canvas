/**
 * Arg-parsing unit tests for the sweep CLI.
 *
 * We test the parser as a pure function (it lives in renders-sweep.ts
 * but is exported below for tests). The actual DB/storage paths are
 * exercised manually via `pnpm renders:sweep --dry-run` against a live
 * Postgres — adding a full integration test for the sweep itself would
 * require seeding fixtures with mixed expires_at / deleted_at values
 * and is best done as part of the docs+ops work in TASK-176.
 *
 * Vitest picks this up via the `src/**\/*.test.ts` glob — but this file
 * lives in `scripts/`. Adding `scripts/**\/*.test.ts` to the include
 * pattern in vitest.config.ts.
 */
import { describe, expect, it } from 'vitest';
import { parseArgsForTesting } from './renders-sweep';

describe('parseArgs', () => {
	it('returns the documented defaults with no args', () => {
		expect(parseArgsForTesting([])).toEqual({
			mode: 'both',
			dryRun: false,
			maxRows: 10_000,
			reapAfterDays: 30
		});
	});

	it('honors --mode=expire / reap / both', () => {
		expect(parseArgsForTesting(['--mode=expire']).mode).toBe('expire');
		expect(parseArgsForTesting(['--mode=reap']).mode).toBe('reap');
		expect(parseArgsForTesting(['--mode=both']).mode).toBe('both');
	});

	it('honors --dry-run', () => {
		expect(parseArgsForTesting(['--dry-run']).dryRun).toBe(true);
	});

	it('parses --max-rows', () => {
		expect(parseArgsForTesting(['--max-rows=500']).maxRows).toBe(500);
	});

	it('parses --reap-after-days', () => {
		expect(parseArgsForTesting(['--reap-after-days=7']).reapAfterDays).toBe(7);
	});

	it('rejects --mode with an unknown value', () => {
		expect(() => parseArgsForTesting(['--mode=nope'])).toThrow(/Invalid --mode/);
	});

	it('rejects non-positive integer --max-rows', () => {
		expect(() => parseArgsForTesting(['--max-rows=0'])).toThrow(/Invalid --max-rows/);
		expect(() => parseArgsForTesting(['--max-rows=-1'])).toThrow(/Invalid --max-rows/);
		expect(() => parseArgsForTesting(['--max-rows=abc'])).toThrow(/Invalid --max-rows/);
	});

	it('rejects negative --reap-after-days', () => {
		expect(() => parseArgsForTesting(['--reap-after-days=-1'])).toThrow(
			/Invalid --reap-after-days/
		);
	});

	it('rejects unknown args', () => {
		expect(() => parseArgsForTesting(['--surprise'])).toThrow(/Unknown argument/);
	});
});
