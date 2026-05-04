/**
 * Render endpoint protection (TASK-72).
 *
 * Two independent layers — a process-wide concurrency semaphore and a
 * per-IP token bucket — guard the public /c/[slug]/[file] route from
 * being CPU-pinned by a curl loop. Both are in-memory (single-process)
 * for v0.4. When we go multi-replica we'll swap the per-IP store for
 * Redis or Postgres without changing call sites — see IDEA-58 for the
 * follow-up plan around API keys.
 *
 * Public surface:
 *   - acquireRenderSlot(): returns a release fn or throws RenderBusy.
 *   - checkRateLimit(ip): returns { allowed, remaining, retryAfter }.
 *   - getClientIp(headers, fallback): extracts the first-hop IP.
 *
 * Cache hits skip both — only renders that actually consume CPU should
 * count against the budget.
 */

/** Default cap; override via RENDER_CONCURRENCY env var. */
const DEFAULT_CONCURRENCY = 4;
/** How long a queued request will wait for a slot before 503'ing. */
const DEFAULT_QUEUE_TIMEOUT_MS = 5000;
/** Per-IP requests per minute. Override via RENDER_RATE_PER_MIN. */
const DEFAULT_RATE_PER_MIN = 60;

function readIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const CONCURRENCY = readIntEnv('RENDER_CONCURRENCY', DEFAULT_CONCURRENCY);
const QUEUE_TIMEOUT_MS = readIntEnv('RENDER_QUEUE_TIMEOUT_MS', DEFAULT_QUEUE_TIMEOUT_MS);
const RATE_PER_MIN = readIntEnv('RENDER_RATE_PER_MIN', DEFAULT_RATE_PER_MIN);

/** Process-wide semaphore. */
let activeRenders = 0;
const waiters: Array<{
	resolve: () => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}> = [];

/** Surface a typed error so the route can map to 503 cleanly. */
export class RenderBusyError extends Error {
	constructor(
		public retryAfterSeconds: number,
		message = 'Render queue full'
	) {
		super(message);
		this.name = 'RenderBusyError';
	}
}

/**
 * Acquire a render slot. Returns a release callback that MUST be called
 * (use try/finally). When the cap is reached, the caller waits up to
 * QUEUE_TIMEOUT_MS for a slot — if the timeout fires first, throws
 * RenderBusyError so the route returns 503.
 */
export async function acquireRenderSlot(): Promise<() => void> {
	if (activeRenders < CONCURRENCY) {
		activeRenders++;
		return release;
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			const idx = waiters.findIndex((w) => w.resolve === resolve);
			if (idx >= 0) waiters.splice(idx, 1);
			reject(new RenderBusyError(Math.ceil(QUEUE_TIMEOUT_MS / 1000), 'Render queue timeout'));
		}, QUEUE_TIMEOUT_MS);
		waiters.push({ resolve, reject, timer });
	});
	// When resolved, the count was already incremented by the prior
	// release(). We don't want a double-bump here.
	return release;
}

function release(): void {
	const next = waiters.shift();
	if (next) {
		clearTimeout(next.timer);
		next.resolve();
	} else {
		activeRenders = Math.max(0, activeRenders - 1);
	}
}

/** Per-IP token bucket. Map keyed by IP, value = current bucket state. */
interface Bucket {
	tokens: number;
	lastRefillMs: number;
}
const buckets = new Map<string, Bucket>();

/**
 * Check whether `ip` may make one render request right now. Decrements
 * the bucket if allowed. Returns metadata for the route to set on
 * X-RateLimit-* headers (and Retry-After on 429).
 *
 * The bucket refills at RATE_PER_MIN tokens/minute, capped at the same
 * value (so a quiet user can burst up to the per-minute limit, then
 * pays for each subsequent request linearly).
 *
 * To keep the map from growing unbounded over a long uptime, we drop
 * any bucket whose last refill was more than 10 minutes ago when we
 * happen to touch it. Not a hot path for cleanup — this is a v0.4
 * single-process limiter, not a production-grade Redis store.
 */
export function checkRateLimit(ip: string): {
	allowed: boolean;
	remaining: number;
	limit: number;
	retryAfterSeconds: number;
} {
	const now = Date.now();
	const ratePerMs = RATE_PER_MIN / 60_000;
	let bucket = buckets.get(ip);
	if (!bucket) {
		bucket = { tokens: RATE_PER_MIN, lastRefillMs: now };
		buckets.set(ip, bucket);
	} else {
		// Lazy stale eviction.
		if (now - bucket.lastRefillMs > 10 * 60_000) {
			bucket.tokens = RATE_PER_MIN;
		} else {
			const elapsed = now - bucket.lastRefillMs;
			bucket.tokens = Math.min(RATE_PER_MIN, bucket.tokens + elapsed * ratePerMs);
		}
		bucket.lastRefillMs = now;
	}
	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return {
			allowed: true,
			remaining: Math.floor(bucket.tokens),
			limit: RATE_PER_MIN,
			retryAfterSeconds: 0
		};
	}
	const tokensNeeded = 1 - bucket.tokens;
	const retryAfterSeconds = Math.max(1, Math.ceil(tokensNeeded / ratePerMs / 1000));
	return {
		allowed: false,
		remaining: 0,
		limit: RATE_PER_MIN,
		retryAfterSeconds
	};
}

/**
 * Pull the client IP from the request.
 *
 * X-Forwarded-For / X-Real-IP are HONORED ONLY when TRUST_PROXY is
 * explicitly truthy in the environment. Default is the strict posture:
 * trust only `getClientAddress()` (the raw socket peer). Without this,
 * a curl loop could rotate spoofed XFF values to bypass per-IP rate
 * limits — every spoofed value gets its own bucket.
 *
 * Operators running behind a real reverse proxy (nginx, Caddy,
 * Cloudflare) set TRUST_PROXY=1 so the limit applies to the actual
 * client and not the proxy's loopback IP.
 */
const TRUST_PROXY = (() => {
	const v = process.env.TRUST_PROXY;
	if (!v) return false;
	const lower = v.trim().toLowerCase();
	return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on';
})();

export function getClientIp(headers: Headers, fallback: string | null): string {
	if (TRUST_PROXY) {
		const xff = headers.get('x-forwarded-for');
		if (xff) {
			const first = xff.split(',')[0]?.trim();
			if (first) return first;
		}
		const real = headers.get('x-real-ip');
		if (real) return real.trim();
	}
	return fallback ?? 'unknown';
}

/** Test-only hook to reset state between unit tests. */
export function resetRenderThrottleStateForTesting(): void {
	activeRenders = 0;
	waiters.splice(0);
	buckets.clear();
}

/** Read-only constants exposed for tests + headers. */
export const RENDER_THROTTLE_CONFIG = {
	concurrency: CONCURRENCY,
	queueTimeoutMs: QUEUE_TIMEOUT_MS,
	ratePerMin: RATE_PER_MIN
};
