/**
 * Pure-helper unit tests for `render-events-sweep.mjs`.
 *
 * Exercises the arg parser and the retention-env reader. The actual
 * DB-touching sweep path is verified manually via
 * `RENDER_EVENTS_RETENTION_DAYS=0 pnpm events:sweep --dry-run`
 * against a live Postgres — adding a full integration test for the
 * sweep itself would require seeding events fixtures with mixed
 * `created_at` values and is best done as part of the ops work in
 * TASK-200.
 *
 * Picked up by vitest via the existing `scripts/**\/*.test.ts`
 * include pattern.
 */
import { describe, expect, it } from 'vitest';
import { parseArgsForTesting, parseRetentionDays } from './render-events-sweep.mjs';

describe('events-sweep parseArgs', () => {
	it('returns the documented defaults with no args', () => {
		expect(parseArgsForTesting([])).toEqual({
			dryRun: false,
			maxRows: null
		});
	});

	it('honors --dry-run', () => {
		expect(parseArgsForTesting(['--dry-run']).dryRun).toBe(true);
	});

	it('parses --max-rows=N', () => {
		expect(parseArgsForTesting(['--max-rows=500']).maxRows).toBe(500);
	});

	it('rejects empty / non-numeric / non-positive --max-rows', () => {
		expect(() => parseArgsForTesting(['--max-rows='])).toThrow(/Invalid --max-rows/);
		expect(() => parseArgsForTesting(['--max-rows=abc'])).toThrow(/Invalid --max-rows/);
		expect(() => parseArgsForTesting(['--max-rows=0'])).toThrow(/Invalid --max-rows/);
		expect(() => parseArgsForTesting(['--max-rows=-1'])).toThrow(/Invalid --max-rows/);
		expect(() => parseArgsForTesting(['--max-rows=1.5'])).toThrow(/Invalid --max-rows/);
	});

	it('rejects unknown flags rather than silently ignoring (cron typos must surface)', () => {
		expect(() => parseArgsForTesting(['--bogus'])).toThrow(/Unknown argument/);
	});

	it('combines --dry-run + --max-rows', () => {
		expect(parseArgsForTesting(['--dry-run', '--max-rows=10'])).toEqual({
			dryRun: true,
			maxRows: 10
		});
	});
});

describe('events-sweep parseRetentionDays', () => {
	it('defaults to 30 when the env is undefined or empty', () => {
		expect(parseRetentionDays(undefined)).toBe(30);
		expect(parseRetentionDays('')).toBe(30);
	});

	it('honors the documented "disable" value of 0', () => {
		// `RENDER_EVENTS_RETENTION_DAYS=0` is the disable switch (every
		// row is past the cutoff every run) per TASK-200.
		expect(parseRetentionDays('0')).toBe(0);
	});

	it('parses positive integers', () => {
		expect(parseRetentionDays('1')).toBe(1);
		expect(parseRetentionDays('365')).toBe(365);
	});

	it('rejects non-numeric / negative / fractional values', () => {
		expect(() => parseRetentionDays('abc')).toThrow(/Invalid RENDER_EVENTS_RETENTION_DAYS/);
		expect(() => parseRetentionDays('-1')).toThrow(/Invalid RENDER_EVENTS_RETENTION_DAYS/);
		expect(() => parseRetentionDays('1.5')).toThrow(/Invalid RENDER_EVENTS_RETENTION_DAYS/);
	});
});
