/**
 * `throwFromResponse(res)` — turn a non-2xx `Response` into a typed
 * `CanvasError` subclass and throw.
 *
 * Used by the upcoming fetch wrapper (TASK-220) so every async method
 * — `bake`, `list`, `get`, `delete` — surfaces failures as the same
 * typed errors. The mapping policy lives here so it's testable in
 * isolation from any network plumbing.
 */
import {
	CanvasError,
	CanvasNotFoundError,
	InvalidParamError,
	QuotaExceededError,
	RateLimitError,
	type RateLimitInfo
} from './errors.js';

/** Best-effort JSON parse. Falls back to the response text on failure. */
async function readBody(res: Response): Promise<unknown> {
	const text = await res.text().catch(() => '');
	if (text.length === 0) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Extract the `error` code string from a JSON body, when present. */
export function extractErrorCode(body: unknown): string | undefined {
	if (body !== null && typeof body === 'object' && 'error' in body) {
		const value = (body as { error: unknown }).error;
		return typeof value === 'string' ? value : undefined;
	}
	return undefined;
}

/** Read a header as a finite integer, or `null` if missing/unparseable. */
function readIntHeader(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null) return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** Read a `number` body field, or `null` if missing/wrong type. */
function readNumberField(body: unknown, key: string): number | null {
	if (body === null || typeof body !== 'object' || !(key in body)) return null;
	const value = (body as Record<string, unknown>)[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a `string` body field, or `null` if missing/wrong type. */
function readStringField(body: unknown, key: string): string | null {
	if (body === null || typeof body !== 'object' || !(key in body)) return null;
	const value = (body as Record<string, unknown>)[key];
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parse a `Retry-After` header value into a delay in milliseconds.
 * RFC 9110 allows two forms:
 *
 * - **delta-seconds** — a non-negative integer of seconds to wait.
 * - **HTTP-date** — e.g. `Fri, 17 May 2026 14:23:00 GMT`. The
 *   resulting delay is `date - now`.
 *
 * Returns 1000 (1s default) when the header is missing, unparseable,
 * or already in the past. The 1s floor keeps callers off a busy loop
 * without making a transient stall pin the request.
 *
 * Lives here (not in request.ts) so both the retry loop AND the
 * `throwFromResponse` path use the same parser when constructing
 * a `RateLimitError.retryAfterSeconds` — otherwise a manual `catch`
 * on a date-form Retry-After would see `retryAfterSeconds: 0` even
 * though the retry loop would honor the value correctly.
 */
export function parseRetryAfter(raw: string | null, now: number = Date.now()): number {
	if (raw === null) return 1000;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return 1000;
	// Numeric (delta-seconds) form — fast path, what Canvas's own
	// server emits.
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
	}
	// HTTP-date form. `Date.parse` accepts RFC 1123 (the form RFC 9110
	// mandates), RFC 850, and asctime — broad enough that we don't
	// need to be picky about format. NaN on garbage.
	const epoch = Date.parse(trimmed);
	if (!Number.isFinite(epoch)) return 1000;
	const delta = epoch - now;
	return delta > 0 ? delta : 1000;
}

/** Parse the rate-limit triplet off a response's headers. */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
	return {
		limit: readIntHeader(headers, 'X-RateLimit-Limit'),
		remaining: readIntHeader(headers, 'X-RateLimit-Remaining'),
		resetSeconds: readIntHeader(headers, 'X-RateLimit-Reset')
	};
}

/**
 * Inspect a non-2xx `Response`, build the right typed error, and throw.
 *
 * Disambiguation order:
 *
 * 1. **`code === 'rate_limited'`** → `RateLimitError` (regardless of
 *    status; the server uses 429 today but anchoring on the code
 *    decouples the SDK from any future status reshuffle).
 * 2. **`code === 'quota_exceeded'`** → `QuotaExceededError` (server
 *    currently emits this at 429 too — same disambiguation rationale).
 * 3. **`code === 'canvas_not_found'`** → `CanvasNotFoundError`.
 * 4. **HTTP 400** → `InvalidParamError` carrying whatever `code` /
 *    `field` / `message` the body has. The server emits 11+ distinct
 *    `invalid_*` codes (`invalid_param`, `invalid_params`,
 *    `invalid_canvas`, `invalid_format`, `invalid_dpr`,
 *    `invalid_forward_url`, `invalid_og_title`, `invalid_cursor`, …);
 *    enumerating them in the SDK would mean every new server-side
 *    validator drifts the mapping. A blanket "400 → InvalidParam,
 *    pass through whatever the body says" is more durable.
 * 5. Status-only fallbacks: 404 → `CanvasNotFoundError`, 429 → generic
 *    `RateLimitError`.
 * 6. Otherwise → base `CanvasError`.
 *
 * The caller is responsible for only invoking this when `!res.ok` —
 * `throwFromResponse(okResponse)` would build an error from a 2xx body
 * which is almost certainly a bug.
 */
export async function throwFromResponse(res: Response): Promise<never> {
	const body = await readBody(res);
	const code = extractErrorCode(body);

	// 1. Rate limit — anchored on body code, not status, so a future
	//    server change that moves rate_limited to 503 still surfaces
	//    as RateLimitError.
	if (code === 'rate_limited') {
		// `retryAfterSeconds` comes from the body when the server sets
		// it explicitly (Canvas's own server does). Otherwise fall back
		// to the `Retry-After` header — and parse it through
		// `parseRetryAfter` so infra-layer date-form values also map
		// to a useful seconds count. (Codex round 2.)
		const bodyRetry = readNumberField(body, 'retryAfterSeconds');
		const headerRetryMs = parseRetryAfter(res.headers.get('Retry-After'));
		const retryAfter = bodyRetry ?? Math.ceil(headerRetryMs / 1000);
		throw new RateLimitError(
			retryAfter > 0
				? `Rate limit exceeded; retry after ${retryAfter}s.`
				: 'Rate limit exceeded.',
			{
				retryAfterSeconds: retryAfter,
				rateLimit: parseRateLimitHeaders(res.headers),
				body
			}
		);
	}

	// 2. Quota exceeded.
	if (code === 'quota_exceeded') {
		const limit = readNumberField(body, 'limit');
		const current = readNumberField(body, 'current');
		const detail =
			limit !== null && current !== null
				? ` (${current} of ${limit} used)`
				: '';
		throw new QuotaExceededError(`Render quota exceeded${detail}.`, {
			status: res.status,
			limit,
			current,
			body
		});
	}

	// 3. Canvas not found.
	if (code === 'canvas_not_found') {
		throw new CanvasNotFoundError('Canvas not found or not accessible.', { body });
	}

	// 4. Any 400 → InvalidParamError. The server emits 11+ distinct
	//    `invalid_*` codes (validated for params, canvas, format, dpr,
	//    forwardUrl, og fields, cursor, …) and may add more; the SDK
	//    bundles them all under InvalidParamError and passes the
	//    server's `code` / `field` / `message` through verbatim so
	//    callers can branch on `err.code` if they need precise
	//    handling.
	if (res.status === 400) {
		throw new InvalidParamError(readStringField(body, 'message') ?? 'Invalid request.', {
			code: code ?? 'invalid_request',
			field: readStringField(body, 'field'),
			body
		});
	}

	// 5. Status-only fallbacks for unknown body codes.
	if (res.status === 404) {
		throw new CanvasNotFoundError('Canvas not found or not accessible.', { body });
	}
	if (res.status === 429) {
		// Same parser as the body-coded branch above so date-form
		// Retry-After from infra proxies maps correctly. (Codex round 2.)
		const headerRetryMs = parseRetryAfter(res.headers.get('Retry-After'));
		throw new RateLimitError('Rate limit exceeded.', {
			retryAfterSeconds: Math.ceil(headerRetryMs / 1000),
			rateLimit: parseRateLimitHeaders(res.headers),
			body
		});
	}

	// 6. Everything else — base CanvasError.
	throw new CanvasError(
		`Canvas API request failed (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}).`,
		{ status: res.status, code, body }
	);
}
