/**
 * Filesystem-backed render cache (TASK-53).
 *
 * Replaces the v0.1 in-memory Map. Lives at CACHE_DIR (default
 * ./.cache/render) with files sharded by the first two hash chars to
 * avoid blowing past per-directory entry limits. Survives `pnpm dev`
 * restarts and `docker compose restart app`.
 *
 * Eviction is LRU by access time, capped at CACHE_MAX_MB
 * (default 500MB). The size index lives in memory and is rebuilt by
 * scanning CACHE_DIR on first use — cheap because we stat every entry
 * once at startup, not per-request.
 *
 * Key shape (built by callers, not the cache module): a stable string
 * derived from canvasId + sorted-params + format. Hashing happens here
 * so callers don't have to think about filesystem-safe characters.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export interface RenderCacheOptions {
	dir?: string;
	maxBytes?: number;
}

interface IndexEntry {
	path: string;
	size: number;
	atimeMs: number;
}

export class FsRenderCache {
	private dir: string;
	private maxBytes: number;
	/** path → entry. Rebuilt at startup by scanning the cache dir. */
	private index = new Map<string, IndexEntry>();
	/** Lazily-resolved promise so the first get() / set() awaits the
	 * scan, but subsequent ones don't. */
	private indexReady: Promise<void> | null = null;

	constructor(opts: RenderCacheOptions = {}) {
		this.dir = opts.dir ?? './.cache/render';
		this.maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
		// Ensure the directory exists synchronously at construction so
		// downstream writes don't race the first mkdir.
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true });
		}
	}

	private async ensureIndexLoaded(): Promise<void> {
		if (!this.indexReady) {
			this.indexReady = this.scanIndex();
		}
		return this.indexReady;
	}

	private async scanIndex(): Promise<void> {
		// Walk the two-char shard subdirs. Anything else is ignored.
		try {
			const shards = await readdir(this.dir, { withFileTypes: true });
			for (const s of shards) {
				if (!s.isDirectory()) continue;
				const shardPath = join(this.dir, s.name);
				const files = await readdir(shardPath);
				for (const f of files) {
					const filePath = join(shardPath, f);
					try {
						const st = await stat(filePath);
						if (!st.isFile()) continue;
						this.index.set(filePath, {
							path: filePath,
							size: st.size,
							atimeMs: st.atimeMs
						});
					} catch {
						// File vanished between readdir and stat — skip.
					}
				}
			}
		} catch {
			// Cache dir doesn't exist yet (we created it in the
			// constructor, but stale FS could miss). Empty index is fine.
		}
	}

	/** Returns a deterministic on-disk path for `key`. The first two
	 * characters of the hash form a shard subdirectory so a busy cache
	 * doesn't end up with millions of files in one folder. `ext` keeps
	 * cached PNG/JPG/WebP visually distinguishable on disk. */
	private pathFor(key: string, ext: string): string {
		const hash = createHash('sha256').update(key).digest('hex');
		return join(this.dir, hash.slice(0, 2), `${hash}.${ext}`);
	}

	async get(key: string, ext: string): Promise<Buffer | null> {
		await this.ensureIndexLoaded();
		const path = this.pathFor(key, ext);
		const entry = this.index.get(path);
		if (!entry) return null;
		try {
			const buf = await readFile(path);
			// Refresh atime so this entry counts as recently-used. Best
			// effort — if utimes fails (read-only mount) the cache still
			// works, just with slightly stale LRU ordering. NOTE: Node's
			// Date constructor expects milliseconds; an earlier version
			// of this file passed `now / 1000` and ended up writing 1970
			// timestamps, which scanIndex then re-read on restart and
			// happily evicted as "oldest first". Pass `now` verbatim.
			const now = Date.now();
			const stamp = new Date(now);
			void utimes(path, stamp, stamp).catch(() => {});
			entry.atimeMs = now;
			return buf;
		} catch {
			// File on disk no longer matches the index — drop the stale
			// entry so we don't keep returning null forever.
			this.index.delete(path);
			return null;
		}
	}

	async set(key: string, ext: string, buf: Buffer): Promise<void> {
		await this.ensureIndexLoaded();
		const path = this.pathFor(key, ext);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, buf);
		this.index.set(path, {
			path,
			size: buf.length,
			atimeMs: Date.now()
		});
		await this.evictIfOver();
	}

	/** Total bytes currently tracked. Public for tests; trivial cost. */
	totalBytes(): number {
		let total = 0;
		for (const e of this.index.values()) total += e.size;
		return total;
	}

	private async evictIfOver(): Promise<void> {
		let total = this.totalBytes();
		if (total <= this.maxBytes) return;
		// Sort by atime ascending — oldest access goes first.
		const sorted = [...this.index.values()].sort((a, b) => a.atimeMs - b.atimeMs);
		for (const entry of sorted) {
			if (total <= this.maxBytes) break;
			total -= entry.size;
			this.index.delete(entry.path);
			try {
				await unlink(entry.path);
			} catch {
				// File already gone — index out-of-sync with disk; ignore.
			}
		}
	}
}

/** Module-singleton cache used by the public render endpoint. Tests
 * that need an isolated cache should construct their own
 * `new FsRenderCache(...)` rather than poking this. */
let defaultCache: FsRenderCache | null = null;
export function getDefaultRenderCache(): FsRenderCache {
	if (!defaultCache) {
		const dir = process.env.CACHE_DIR ?? './.cache/render';
		const cap = process.env.CACHE_MAX_MB ? Number(process.env.CACHE_MAX_MB) : 500;
		const maxBytes = (Number.isFinite(cap) ? cap : 500) * 1024 * 1024;
		defaultCache = new FsRenderCache({ dir, maxBytes });
	}
	return defaultCache;
}
