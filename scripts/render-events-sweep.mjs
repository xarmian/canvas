#!/usr/bin/env node
/**
 * Retention sweep for `render_events`.
 *
 * Hard-deletes events whose `created_at` is older than the configured
 * retention window. Mirrors the `renders-sweep.mjs` patterns for arg
 * parsing, log shape, and transaction safety so operators can run both
 * cron jobs side-by-side without surprises — but the model is simpler:
 *
 *   - **Hard-delete only.** Events are immutable observations; there's
 *     no `deleted_at` / reap split.
 *   - **No storage cleanup.** Events don't reference blobs.
 *
 * Plain `.mjs` (not `.ts`) so production cron in the Docker runner can
 * `node scripts/render-events-sweep.mjs` directly — no tsx, no compile.
 *
 * Concurrency safety: the SELECT uses `FOR UPDATE SKIP LOCKED` inside
 * an explicit transaction so two simultaneous sweepers partition the
 * work without deadlocking. Same posture as `renders-sweep.mjs`.
 *
 * Retention semantics:
 *
 *   - `RENDER_EVENTS_RETENTION_DAYS` (default `30`). Events strictly
 *     older than `now() - retention_days` are deleted.
 *   - `RENDER_EVENTS_RETENTION_DAYS=0` is the "disable logging" knob —
 *     every row is past the cutoff every time the sweep runs, so the
 *     table is kept at zero. Documented in README under TASK-200.
 */
import 'dotenv/config';
import postgres from 'postgres';

// ─── arg parsing ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} ParsedArgs
 * @property {boolean} dryRun
 * @property {number | null} maxRows  null = no cap (default)
 */

/**
 * Pure arg parser. Throws `Error` on invalid input; exported for unit
 * tests. The CLI entry point wraps this and converts thrown errors to
 * `process.exit(1)` with a usage message.
 *
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgsForTesting(argv) {
	/** @type {ParsedArgs} */
	const args = {
		dryRun: false,
		maxRows: null
	};
	for (const raw of argv) {
		if (raw === '--dry-run') {
			args.dryRun = true;
			continue;
		}
		const eq = raw.indexOf('=');
		if (raw.startsWith('--max-rows')) {
			const v = eq > 0 ? raw.slice(eq + 1) : '';
			if (v === '') throw new Error('Invalid --max-rows: (missing)');
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
				throw new Error(`Invalid --max-rows: ${v}`);
			}
			args.maxRows = n;
			continue;
		}
		if (raw === '--help' || raw === '-h') {
			throw new HelpRequested();
		}
		throw new Error(`Unknown argument: ${raw}`);
	}
	return args;
}

class HelpRequested extends Error {
	constructor() {
		super('help');
		this.name = 'HelpRequested';
	}
}

function parseArgs(argv) {
	try {
		return parseArgsForTesting(argv);
	} catch (err) {
		if (err instanceof HelpRequested) printUsage(0);
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[events-sweep] ${reason}`);
		printUsage(1);
	}
}

function printUsage(code) {
	console.error(`Usage: pnpm events:sweep [--dry-run] [--max-rows=N]
Defaults: --max-rows=(no cap)
Retention is controlled by RENDER_EVENTS_RETENTION_DAYS (default 30).
Set RENDER_EVENTS_RETENTION_DAYS=0 to keep the table at zero rows.`);
	process.exit(code);
}

// ─── retention parsing ────────────────────────────────────────────────────

/**
 * Read `RENDER_EVENTS_RETENTION_DAYS` from env, defaulting to 30.
 * Exported for unit tests.
 *
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parseRetentionDays(raw) {
	if (raw === undefined || raw === '') return 30;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
		throw new Error(`Invalid RENDER_EVENTS_RETENTION_DAYS: ${raw}`);
	}
	return n;
}

// ─── sweep ────────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof postgres>} sql
 * @param {ParsedArgs} args
 * @param {number} retentionDays
 */
async function runSweep(sql, args, retentionDays) {
	const start = Date.now();
	// `FOR UPDATE SKIP LOCKED` only holds locks for the surrounding
	// transaction. Without `BEGIN`/`COMMIT`, Postgres releases them as
	// soon as the SELECT finishes and a concurrent sweeper could re-pick
	// the same rows.
	return await sql.begin(async (tx) => {
		// Compute the cutoff on the DB side so the dry-run number matches
		// what an immediate non-dry-run would do (no client-clock drift).
		const [{ cutoff }] = await tx`
			SELECT now() - make_interval(days => ${retentionDays}) AS cutoff
		`;
		// `maxRows = null` → no LIMIT (operator wants to drain the
		// backlog in one pass). The empty fragment keeps Postgres happy.
		const limitClause = args.maxRows === null ? tx`` : tx`LIMIT ${args.maxRows}`;

		if (args.dryRun) {
			// Dry-run: just count. We don't need the ids — and selecting them
			// for a large backlog is unnecessary memory pressure when nothing
			// will be deleted.
			const [{ would_sweep }] = await tx`
				SELECT COUNT(*)::int AS would_sweep
				FROM (
					SELECT 1
					FROM render_events
					WHERE created_at < ${cutoff}
					ORDER BY created_at ASC
					${limitClause}
				) AS s
			`;
			return {
				swept: 0,
				wouldSweep: Number(would_sweep),
				dryRun: true,
				cutoff,
				ms: Date.now() - start
			};
		}

		// Single-statement CTE delete (Codex round 1, P1). The earlier
		// implementation selected ids into the client and re-expanded them
		// as `IN ($1, $2, …)` parameters in the DELETE — a backlog over
		// Postgres's 65535-parameter limit would blow up there and delete
		// nothing. Materializing the victim set inside a CTE keeps the
		// ids server-side end-to-end. The CTE still uses
		// `FOR UPDATE SKIP LOCKED` so concurrent sweepers partition the
		// work, and Postgres holds the row locks for the surrounding
		// transaction (committed implicitly by `sql.begin`).
		const result = await tx`
			WITH victims AS (
				SELECT id
				FROM render_events
				WHERE created_at < ${cutoff}
				ORDER BY created_at ASC
				${limitClause}
				FOR UPDATE SKIP LOCKED
			)
			DELETE FROM render_events
			WHERE id IN (SELECT id FROM victims)
		`;
		const swept = Number(result.count ?? 0);

		return { swept, wouldSweep: swept, dryRun: false, cutoff, ms: Date.now() - start };
	});
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		console.error('[events-sweep] DATABASE_URL is required');
		process.exit(1);
	}

	let retentionDays;
	try {
		retentionDays = parseRetentionDays(process.env.RENDER_EVENTS_RETENTION_DAYS);
	} catch (err) {
		console.error(`[events-sweep] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
		return;
	}

	const sql = postgres(connectionString, { max: 1 });
	try {
		const result = await runSweep(sql, args, retentionDays);
		const cutoffStr =
			result.cutoff instanceof Date
				? result.cutoff.toISOString().slice(0, 10)
				: String(result.cutoff).slice(0, 10);
		// Machine-greppable summary line (per TASK-200 spec). Logs go to
		// stdout so operators can pipe to log aggregators verbatim.
		const verb = args.dryRun ? 'would sweep' : 'swept';
		const count = args.dryRun ? result.wouldSweep : result.swept;
		console.log(
			`${verb} ${count} rows older than ${cutoffStr} (retention=${retentionDays}d, ${result.ms}ms)`
		);
	} catch (err) {
		console.error(`[events-sweep] failed: ${err instanceof Error ? err.message : String(err)}`);
		if (err instanceof Error && err.stack) {
			console.error(err.stack);
		}
		process.exit(1);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

// Only auto-run when invoked as a CLI (not when imported by tests).
if (
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith('render-events-sweep.mjs')
) {
	void main();
}
