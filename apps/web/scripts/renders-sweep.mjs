#!/usr/bin/env node
/**
 * Sweep job for `rendered_images`.
 *
 * Two modes:
 *
 *   - **expire**: rows with `expires_at < now() AND deleted_at IS NULL`
 *     get their bytes dropped from storage and `deleted_at` set.
 *     Idempotent.
 *
 *   - **reap**: rows soft-deleted longer than the grace period (default
 *     30 days) get hard-deleted from the DB. The grace lets an operator
 *     run forensic queries on recently-deleted rows before they vanish.
 *
 * `--mode=both` runs expire then reap in a single invocation — the
 * default cron shape.
 *
 * Plain `.mjs` (not `.ts`) so production cron in the Docker runner can
 * invoke it directly with `node scripts/renders-sweep.mjs` — no tsx, no
 * compilation step. Mirrors the `scripts/run-migrations.mjs` shape.
 *
 * Concurrency safety: the SELECTs use `FOR UPDATE SKIP LOCKED` inside an
 * explicit transaction so two simultaneous sweepers partition the work
 * (locks held only until the surrounding transaction commits).
 *
 * Storage adapter selection mirrors `src/lib/server/storage/index.ts`:
 *   STORAGE_LOCAL=true       → local filesystem (default basePath
 *                              `<cwd>/.local-storage`).
 *   else                     → S3 via @aws-sdk/client-s3 (uses
 *                              S3_ENDPOINT / KEY / SECRET / BUCKET /
 *                              REGION).
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';

// .env lives at the monorepo root. Local invocations via
// `pnpm renders:sweep` run with cwd=apps/web (the workspace
// delegator), so the default `dotenv/config` would look for a
// non-existent `apps/web/.env`. The production Docker runner passes
// env vars via docker-compose so the file load is a no-op there.
// (Codex round 2 P2.)
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

// ─── arg parsing ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} ParsedArgs
 * @property {'expire'|'reap'|'both'} mode
 * @property {boolean} dryRun
 * @property {number} maxRows
 * @property {number} reapAfterDays
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
			if (v === '') throw new Error('Invalid --max-rows: (missing)');
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
				throw new Error(`Invalid --max-rows: ${v}`);
			}
			args.maxRows = n;
			continue;
		}
		if (raw.startsWith('--reap-after-days')) {
			const v = eq > 0 ? raw.slice(eq + 1) : '';
			if (v === '') throw new Error('Invalid --reap-after-days: (missing)');
			const n = Number(v);
			if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
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

function parseArgs(argv) {
	try {
		return parseArgsForTesting(argv);
	} catch (err) {
		if (err instanceof HelpRequested) printUsage(0);
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[sweep] ${reason}`);
		printUsage(1);
	}
}

function printUsage(code) {
	console.error(`Usage: pnpm renders:sweep [--mode=both|expire|reap] [--dry-run]
                              [--max-rows=N] [--reap-after-days=N]
Defaults: --mode=both, --max-rows=10000, --reap-after-days=30`);
	process.exit(code);
}

// ─── storage delete ───────────────────────────────────────────────────────

/**
 * Build a `delete(key)` closure matching `StorageAdapter.delete` from
 * `src/lib/server/storage/types.ts`. Inlined here so the script stays
 * self-contained — production cron runs in the Docker runner where
 * `src/` isn't available.
 *
 * @returns {(key: string) => Promise<void>}
 */
function buildStorageDelete() {
	if (process.env.STORAGE_LOCAL === 'true') {
		const basePath = process.env.STORAGE_LOCAL_PATH || join(process.cwd(), '.local-storage');
		return async (key) => {
			const filePath = join(basePath, key);
			if (existsSync(filePath)) unlinkSync(filePath);
		};
	}
	const endpoint = process.env.S3_ENDPOINT;
	const accessKeyId = process.env.S3_ACCESS_KEY;
	const secretAccessKey = process.env.S3_SECRET_KEY;
	const bucket = process.env.S3_BUCKET;
	if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
		throw new Error('S3 storage not configured. Set STORAGE_LOCAL=true or provide S3_* env vars.');
	}
	const client = new S3Client({
		endpoint,
		region: process.env.S3_REGION || 'us-east-1',
		credentials: { accessKeyId, secretAccessKey },
		forcePathStyle: true
	});
	return async (key) => {
		await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	};
}

// ─── log helpers ──────────────────────────────────────────────────────────

function log(msg, extra = {}) {
	console.log(JSON.stringify({ msg, ts: new Date().toISOString(), ...extra }));
}

function logErr(msg, extra = {}) {
	console.error(JSON.stringify({ msg, ts: new Date().toISOString(), ...extra }));
}

// ─── modes ────────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof postgres>} sql
 * @param {(key: string) => Promise<void>} storageDelete
 * @param {ParsedArgs} args
 */
async function runExpire(sql, storageDelete, args) {
	const start = Date.now();
	// `FOR UPDATE SKIP LOCKED` only holds locks for the surrounding
	// transaction. Without `BEGIN`/`COMMIT`, Postgres releases them as
	// soon as the SELECT finishes and a concurrent sweeper could re-pick
	// the same rows before our UPDATE marks them deleted.
	return await sql.begin(async (tx) => {
		const rows = await tx`
            SELECT id, storage_key, size_bytes
            FROM rendered_images
            WHERE expires_at IS NOT NULL
              AND expires_at < now()
              AND deleted_at IS NULL
            ORDER BY expires_at ASC
            LIMIT ${args.maxRows}
            FOR UPDATE SKIP LOCKED
        `;

		if (args.dryRun) {
			log('expire_dry_run', { wouldMark: rows.length });
			return { marked: rows.length, bytesFreed: 0, errors: 0, ms: Date.now() - start };
		}

		let marked = 0;
		let bytesFreed = 0;
		let errors = 0;
		for (const row of rows) {
			try {
				await storageDelete(row.storage_key);
			} catch (err) {
				errors += 1;
				logErr('expire_storage_error', {
					id: row.id,
					key: row.storage_key,
					error: err instanceof Error ? err.message : String(err)
				});
				// Continue — we still mark the row deleted; bytes (if any
				// remain) will be re-tried on the next reap pass.
			}
			await tx`
                UPDATE rendered_images
                SET deleted_at = now()
                WHERE id = ${row.id}
            `;
			marked += 1;
			bytesFreed += Number(row.size_bytes ?? 0);
		}

		return { marked, bytesFreed, errors, ms: Date.now() - start };
	});
}

/**
 * @param {ReturnType<typeof postgres>} sql
 * @param {(key: string) => Promise<void>} storageDelete
 * @param {ParsedArgs} args
 */
async function runReap(sql, storageDelete, args) {
	const start = Date.now();
	return await sql.begin(async (tx) => {
		const rows = await tx`
            SELECT id, storage_key
            FROM rendered_images
            WHERE deleted_at IS NOT NULL
              AND deleted_at < now() - make_interval(days => ${args.reapAfterDays})
            ORDER BY deleted_at ASC
            LIMIT ${args.maxRows}
            FOR UPDATE SKIP LOCKED
        `;

		if (args.dryRun) {
			log('reap_dry_run', { wouldDelete: rows.length });
			return { deleted: rows.length, errors: 0, ms: Date.now() - start };
		}

		let deleted = 0;
		let errors = 0;
		for (const row of rows) {
			// Try the blob delete first. If it fails, skip the hard-delete
			// so the DB row keeps the storage_key reference for a future
			// retry pass — otherwise a transient storage hiccup would
			// permanently orphan the blob.
			try {
				await storageDelete(row.storage_key);
			} catch (err) {
				errors += 1;
				logErr('reap_storage_error', {
					id: row.id,
					key: row.storage_key,
					error: err instanceof Error ? err.message : String(err)
				});
				continue;
			}
			await tx`
                DELETE FROM rendered_images
                WHERE id = ${row.id}
            `;
			deleted += 1;
		}

		return { deleted, errors, ms: Date.now() - start };
	});
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		console.error('[sweep] DATABASE_URL is required');
		process.exit(1);
	}

	const totalStart = Date.now();
	log('sweep_start', { mode: args.mode, dryRun: args.dryRun, maxRows: args.maxRows });

	const sql = postgres(connectionString, { max: 1 });
	const storageDelete = buildStorageDelete();

	try {
		if (args.mode === 'expire' || args.mode === 'both') {
			const result = await runExpire(sql, storageDelete, args);
			log('expire_done', result);
		}
		if (args.mode === 'reap' || args.mode === 'both') {
			const result = await runReap(sql, storageDelete, args);
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
		await sql.end({ timeout: 5 });
	}
}

// Only auto-run when invoked as a CLI (not when imported by tests).
if (
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith('renders-sweep.mjs')
) {
	void main();
}
