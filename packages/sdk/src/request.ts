/**
 * Shared `request<T>()` helper that powers every roundtrip method on
 * `CanvasClient` (`bake`, `list`, `get`, `delete`, …).
 *
 * Responsibilities:
 *
 * - Build the full URL from `client.baseUrl` + a path-relative `path`.
 * - Inject the `Authorization: Bearer <apiKey>` header when
 *   `requireAuth: true` and surface a clear `TypeError` when the
 *   client wasn't constructed with an API key.
 * - JSON-serialize a body (when provided) and set the matching
 *   `Content-Type` header.
 * - Run the response through `throwFromResponse()` on non-2xx so
 *   every async method surfaces the same typed errors.
 * - Wrap `fetch`-level network failures in `CanvasError` so consumers
 *   only have to `catch (err: CanvasError)`.
 * - Return `{ data, response }` so callers can read rate-limit
 *   headers off the raw `Response` (TASK-223 wires
 *   `client.lastRateLimit` to this seam).
 */
import type { CanvasClient } from './client.js';
import { CanvasError } from './errors.js';
import { extractErrorCode, parseRateLimitHeaders, throwFromResponse } from './from-response.js';

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
 */
export function parseRetryAfter(raw: string | null, now: number = Date.now()): number {
	if (raw === null) return 1000;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return 1000;
	// Numeric (delta-seconds) form first — cheapest path, and the
	// one Canvas's own server emits.
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

/**
 * Cancellable sleep — `setTimeout` that bails early if the provided
 * AbortSignal trips. Used by the retry path to honor `Retry-After`
 * without making the wait uncancellable.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** HTTP methods the SDK uses. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Options for the shared `request<T>()` helper. */
export interface RequestOptions {
	/** HTTP method. */
	method: HttpMethod;
	/** Path under `client.baseUrl`. Must start with `/`. */
	path: string;
	/**
	 * Query parameters appended to the path. `null` and `undefined`
	 * values are dropped; numbers/booleans are coerced to strings.
	 * Mirrors the public `image()` param-coercion rules so callers
	 * see consistent behavior across surfaces.
	 */
	query?: Record<string, string | number | boolean | null | undefined>;
	/**
	 * Body to JSON-serialize. Omit for GET/DELETE. Pass `null` to send
	 * a literal `null` JSON body (rare; the server doesn't accept it
	 * on any v1 endpoint today).
	 */
	body?: unknown;
	/**
	 * Throw a `TypeError` before the network call when
	 * `client.apiKey` is missing. Defaults to `true` because every v1
	 * endpoint is bearer-authenticated.
	 */
	requireAuth?: boolean;
	/** Forwarded to `fetch` for caller-side cancellation. */
	signal?: AbortSignal;
}

/** Result shape — `data` is the parsed JSON body, `response` is the raw `Response`. */
export interface RequestResult<T> {
	data: T;
	response: Response;
}

/**
 * Issue an authenticated JSON request through the Canvas API.
 *
 * On non-2xx the appropriate `CanvasError` subclass is thrown via
 * `throwFromResponse`. On network failure a generic `CanvasError`
 * (with the underlying error as `cause`) is thrown so callers don't
 * have to special-case `TypeError` from `fetch`.
 *
 * @throws `TypeError` when `requireAuth` is true and the client has
 *   no `apiKey`. This is a configuration error, not a runtime
 *   API error, so it doesn't extend `CanvasError`.
 * @throws `CanvasError` (or a subclass) on any non-2xx response or
 *   network-level failure.
 */
export async function request<T>(
	client: CanvasClient,
	options: RequestOptions
): Promise<RequestResult<T>> {
	const requireAuth = options.requireAuth ?? true;
	if (requireAuth && !client.apiKey) {
		throw new TypeError(
			`CanvasClient: this request requires an API key. Pass { apiKey } to the constructor.`
		);
	}

	// Build the URL: baseUrl + path + optional query string. The query
	// builder uses URLSearchParams so encoding matches what the server
	// route's `url.searchParams` reader consumes — same parity story
	// as `image()`.
	let url = `${client.baseUrl}${options.path}`;
	if (options.query !== undefined) {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(options.query)) {
			if (value === null || value === undefined) continue;
			search.set(key, String(value));
		}
		const queryString = search.toString();
		if (queryString.length > 0) url = `${url}?${queryString}`;
	}

	const headers = new Headers();
	headers.set('Accept', 'application/json');
	if (client.apiKey) {
		headers.set('Authorization', `Bearer ${client.apiKey}`);
	}
	const init: RequestInit = {
		method: options.method,
		headers,
		signal: options.signal
	};
	if (options.body !== undefined) {
		headers.set('Content-Type', 'application/json');
		init.body = JSON.stringify(options.body);
	}

	// Retry loop. The body is the same across attempts (we serialized
	// once above), so re-issuing the request is cheap and side-effect-
	// free from the caller's POV. The server is responsible for the
	// idempotency of the underlying operation — POST /api/v1/renders
	// dedupes by content hash, DELETE is naturally idempotent at the
	// row level, GET is read-only.
	let attempt = 0;
	while (true) {
		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (err) {
			// `fetch` throws on DNS failure, TCP reset, CORS preflight
			// rejection, AbortSignal trips — every reason that doesn't
			// produce a `Response`. Wrap so consumers only have one
			// error hierarchy to catch. Preserve the original via
			// `cause`.
			throw new CanvasError(
				err instanceof Error
					? `Network request failed: ${err.message}`
					: 'Network request failed.',
				{ cause: err }
			);
		}

		// Update `client.lastRateLimit` on every response — success
		// AND failure — so callers can read the latest triplet right
		// after `catch (err)` blocks as well as after `await`.
		client.lastRateLimit = parseRateLimitHeaders(response.headers);

		if (response.ok) {
			// Empty body (204 No Content, or an endpoint that returns
			// nothing on success) yields `undefined` cast as T —
			// callers that ask for `void` get sensible semantics, and
			// DELETE-style operations don't need a fake JSON body
			// server-side.
			const text = await response.text();
			const data = (text.length > 0 ? (JSON.parse(text) as T) : (undefined as T));
			return { data, response };
		}

		// Non-2xx. Decide whether to retry.
		//
		// We retry ONLY on `error: "rate_limited"` (or a bare 429 with
		// no body code — likely an infra-level rate limit). Importantly,
		// `error: "quota_exceeded"` ALSO comes back at HTTP 429 and
		// must NOT be retried — it's a hard ceiling, not a transient
		// throttle, and retrying would just thrash and double-charge
		// quota counters.
		const shouldRetry =
			response.status === 429 &&
			client.retryOn429 &&
			attempt < client.maxRetries;

		if (shouldRetry) {
			// Clone so reading the body for code extraction here
			// doesn't prevent throwFromResponse from reading it below
			// in the giving-up branch.
			const cloned = response.clone();
			const text = await cloned.text();
			let parsed: unknown = null;
			if (text.length > 0) {
				try {
					parsed = JSON.parse(text);
				} catch {
					/* non-JSON 429 — treat as bare 429, retryable */
				}
			}
			const code = extractErrorCode(parsed);

			// Quota is the only 429 we explicitly do NOT retry. Other
			// 429s (rate_limited, or bare 429 with no code) flow into
			// the retry path.
			if (code !== 'quota_exceeded') {
				// `Retry-After` per RFC 9110 accepts either delta-seconds
				// (numeric) OR an HTTP-date. Canvas's own server emits
				// numeric, but infra in front (nginx/cloudflare/proxies)
				// can send the date form for "bare 429" paths — those
				// would silently fall back to 1s under a numeric-only
				// parser (Codex round 1). Try numeric first, then date,
				// then default to 1s.
				const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
				try {
					await sleep(retryAfterMs, options.signal);
				} catch (err) {
					throw new CanvasError(
						err instanceof Error
							? `Request aborted during retry wait: ${err.message}`
							: 'Request aborted during retry wait.',
						{ cause: err }
					);
				}
				attempt++;
				continue;
			}
		}

		// Either non-429, retry disabled, retries exhausted, or
		// quota_exceeded — surface the typed error.
		await throwFromResponse(response);
	}
}
