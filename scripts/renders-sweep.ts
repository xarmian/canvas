#!/usr/bin/env tsx
/**
 * Sweep job for `rendered_images`.
 *
 * Two modes:
 *
 *   - **expire**: rows whose `expires_at` is in the past and that
 *     aren't already soft-deleted get their bytes dropped from storage
 *     and `deleted_at` set to now. Idempotent.
 *
 *   - **reap**: rows that have been soft-deleted longer than the grace
 *     period (default 30 days) get hard-deleted from the DB. The grace
 *     period exists so an operator can run forensic queries
 *     ("how much storage did user X use last month?") on recently
 *     soft-deleted rows before they vanish.
 *
 * `--mode=both` runs expire then reap in a single invocation — the
 * default cron shape.
 *
 * Concurrency safety: the expire SELECT uses `FOR UPDATE SKIP LOCKED`
 * so two simultaneous sweep invocations partition the work between
 * themselves instead of double-processing rows. The reap path uses the
 * same idiom for symmetry.
 *
 * Wired in package.json as `pnpm renders:sweep -- --mode=both`. Cron
 * usage and operator docs live in TASK-176's README updates.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema.js';
import { LocalStorageAdapter } from '../src/lib/server/storage/local.js';
import { S3StorageAdapter } from '../src/lib/server/storage/s3.js';
import type { StorageAdapter } from '../src/lib/server/storage/types.js';

// ─── arg parsing ──────────────────────────────────────────────────────────

type SweepMode = 'expire' | 'reap' | 'both';

interface ParsedArgs {
	mode: SweepMode;
	dryRun: boolean;
	maxRows: number;
	reapAfterDays: number;
}

/**
 * Pure arg-parser. Throws `Error` on invalid input so the unit-test
 * surface can assert via `expect.toThrow`. The CLI entry point wraps
 * this in a try/catch and converts thrown errors to `process.exit(1)`
 * with the usage message.
 */
export function parseArgsForTesting(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		mode: 'both',
		dryRun: false,
		maxRows: 10_000,
		reapAfterDays: 30
	};
	for (const raw of argv) {
		if (raw === '--dry-run') {
			args.dryRun = true;
			continue;
		}
		const eq = raw.indexOf('=');
		if (raw.startsWith('--mode')) {
			const v = eq > 0 ? raw.slice(eq + 1) : '';
			if (v === 'expire' || v === 'reap' || v === 'both') {
				args.mode = v;
				continue;
			}
			throw new Error(`Invalid --mode: ${v || '(missing)'}`);
		}
		if (raw.startsWith('--max-rows')) {
			const v = eq > 0 ? raw.slice(eq + 1) : '';
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
				throw new Error(`Invalid --max-rows: ${v}`);
			}
			args.maxRows = n;
			continue;
		}
		if (raw.startsWith('--reap-after-days')) {
			const v = eq > 0 ? raw.slice(eq + 1) : '';
			const n = Number(v);
			if (!Number.isFinite(n) || n < 0) {
				throw new Error(`Invalid --reap-after-days: ${v}`);
			}
			args.reapAfterDays = n;
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

function parseArgs(argv: string[]): ParsedArgs {
	try {
		return parseArgsForTesting(argv);
	} catch (err) {
		if (err instanceof HelpRequested) printUsage(0);
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[sweep] ${reason}`);
		printUsage(1);
	}
}

function printUsage(code: number): never {
	console.error(`Usage: pnpm renders:sweep [--mode=both|expire|reap] [--dry-run]
                              [--max-rows=N] [--reap-after-days=N]
Defaults: --mode=both, --max-rows=10000, --reap-after-days=30`);
	process.exit(code);
}

// ─── storage adapter selection (mirrors src/lib/server/storage/index.ts) ──

function buildStorage(): StorageAdapter {
	if (process.env.STORAGE_LOCAL === 'true') {
		return new LocalStorageAdapter();
	}
	if (
		!process.env.S3_ENDPOINT ||
		!process.env.S3_ACCESS_KEY ||
		!process.env.S3_SECRET_KEY ||
		!process.env.S3_BUCKET
	) {
		throw new Error('S3 storage not configured. Set STORAGE_LOCAL=true or provide S3_* env vars.');
	}
	return new S3StorageAdapter({
		endpoint: process.env.S3_ENDPOINT,
		accessKeyId: process.env.S3_ACCESS_KEY,
		secretAccessKey: process.env.S3_SECRET_KEY,
		bucket: process.env.S3_BUCKET,
		region: process.env.S3_REGION || 'us-east-1',
		publicUrl: process.env.S3_PUBLIC_URL
	});
}

// ─── log helpers (structured JSON lines) ──────────────────────────────────

function log(msg: string, extra: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ msg, ts: new Date().toISOString(), ...extra }));
}

function logErr(msg: string, extra: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ msg, ts: new Date().toISOString(), ...extra }));
}

// ─── modes ────────────────────────────────────────────────────────────────

type DbClient = ReturnType<typeof drizzle<typeof schema>>;

async function runExpire(
	db: DbClient,
	storage: StorageAdapter,
	args: ParsedArgs
): Promise<{ marked: number; bytesFreed: number; errors: number; ms: number }> {
	const start = Date.now();
	type Row = { id: string; storage_key: string; size_bytes: number };

	// `FOR UPDATE SKIP LOCKED` only holds the locks for the duration of
	// the surrounding transaction (Codex round 1 P2). Without the
	// transaction Postgres releases the locks as soon as the SELECT
	// finishes and a concurrent sweeper could re-pick the same rows
	// before our UPDATE marks them deleted. Holding the transaction
	// open across the per-row UPDATEs keeps the lock window long enough
	// to serialize the partitioning.
	const result = await db.transaction(async (tx) => {
		const rows = await tx.execute<Row>(sql`
            SELECT id, storage_key, size_bytes
            FROM rendered_images
            WHERE expires_at IS NOT NULL
              AND expires_at < now()
              AND deleted_at IS NULL
            ORDER BY expires_at ASC
            LIMIT ${args.maxRows}
            FOR UPDATE SKIP LOCKED
        `);

		if (args.dryRun) {
			log('expire_dry_run', { wouldMark: rows.length });
			return { marked: rows.length, bytesFreed: 0, errors: 0 };
		}

		let marked = 0;
		let bytesFreed = 0;
		let errors = 0;
		for (const row of rows) {
			try {
				await storage.delete(row.storage_key);
			} catch (err) {
				errors += 1;
				logErr('expire_storage_error', {
					id: row.id,
					key: row.storage_key,
					error: err instanceof Error ? err.message : String(err)
				});
				// Continue — we still mark the row deleted; the bytes (if
				// any remain) will be reaped on the next pass.
			}
			await tx
				.update(schema.renderedImages)
				.set({ deletedAt: new Date() })
				.where(eq(schema.renderedImages.id, row.id));
			marked += 1;
			bytesFreed += Number(row.size_bytes ?? 0);
		}

		return { marked, bytesFreed, errors };
	});

	return { ...result, ms: Date.now() - start };
}

async function runReap(
	db: DbClient,
	storage: StorageAdapter,
	args: ParsedArgs
): Promise<{ deleted: number; errors: number; ms: number }> {
	const start = Date.now();
	type Row = { id: string; storage_key: string };
	const cutoffDays = args.reapAfterDays;

	// Same transaction discipline as expire — keep the SKIP LOCKED locks
	// alive long enough to serialize the per-row work (Codex round 1 P2).
	const result = await db.transaction(async (tx) => {
		const rows = await tx.execute<Row>(sql`
            SELECT id, storage_key
            FROM rendered_images
            WHERE deleted_at IS NOT NULL
              AND deleted_at < now() - make_interval(days => ${cutoffDays})
            ORDER BY deleted_at ASC
            LIMIT ${args.maxRows}
            FOR UPDATE SKIP LOCKED
        `);

		if (args.dryRun) {
			log('reap_dry_run', { wouldDelete: rows.length });
			return { deleted: rows.length, errors: 0 };
		}

		let deleted = 0;
		let errors = 0;
		for (const row of rows) {
			// Try the blob delete first. If it fails, skip the hard-delete
			// so the DB row keeps the storage_key reference — otherwise a
			// transient S3 hiccup would permanently orphan the blob with
			// no record left to drive a retry (Codex round 1 P2).
			try {
				await storage.delete(row.storage_key);
			} catch (err) {
				errors += 1;
				logErr('reap_storage_error', {
					id: row.id,
					key: row.storage_key,
					error: err instanceof Error ? err.message : String(err)
				});
				continue;
			}
			await tx.delete(schema.renderedImages).where(eq(schema.renderedImages.id, row.id));
			deleted += 1;
		}

		return { deleted, errors };
	});

	return { ...result, ms: Date.now() - start };
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		console.error('[sweep] DATABASE_URL is required');
		process.exit(1);
	}

	const totalStart = Date.now();
	log('sweep_start', { mode: args.mode, dryRun: args.dryRun, maxRows: args.maxRows });

	// Single connection — the sweep runs serially and we want to release
	// the socket promptly so cron doesn't accumulate sockets.
	const client = postgres(connectionString, { max: 1 });
	const db = drizzle(client, { schema });
	const storage = buildStorage();

	try {
		if (args.mode === 'expire' || args.mode === 'both') {
			const result = await runExpire(db, storage, args);
			log('expire_done', result);
		}
		if (args.mode === 'reap' || args.mode === 'both') {
			const result = await runReap(db, storage, args);
			log('reap_done', result);
		}
		log('sweep_end', { totalMs: Date.now() - totalStart });
	} catch (err) {
		logErr('sweep_failed', {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined
		});
		process.exit(1);
	} finally {
		await client.end({ timeout: 5 });
	}
}

// Only auto-run when invoked as a CLI (not when imported by tests).
// `import.meta.url` is the file's own URL; `process.argv[1]` is the
// entrypoint Node was launched with. If they match, we're the CLI.
if (
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith('renders-sweep.ts')
) {
	void main();
}
