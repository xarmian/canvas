/**
 * Typed error classes for `@canvas-images/sdk`.
 *
 * Every error the SDK raises from a server response inherits from
 * `CanvasError`, so consumers can `catch (err: unknown)` and narrow with
 * `instanceof CanvasError` for "anything the SDK threw," or with one of
 * the subclasses for specific cases.
 *
 * Mapping (HTTP status + body `error` code → class) lives in
 * `from-response.ts`'s `throwFromResponse()` helper. The classes here
 * are the shape; the parser is the policy.
 */

/**
 * Structured rate-limit metadata read from `X-RateLimit-*` response
 * headers. Surfaced on `RateLimitError` (always) and on the upcoming
 * `client.lastRateLimit` accessor (TASK-223, every response).
 */
export interface RateLimitInfo {
	/** Maximum requests per window. `null` if the header was missing. */
	limit: number | null;
	/** Remaining requests in the current window. `null` if missing. */
	remaining: number | null;
	/** Seconds until the bucket fully refills. `null` if missing. */
	resetSeconds: number | null;
}

/**
 * Base class for every typed error the SDK raises. Subclassing one of
 * the more specific errors below is preferred — `CanvasError` itself
 * is what gets thrown for status codes the SDK doesn't have a
 * narrower mapping for.
 */
export class CanvasError extends Error {
	/** HTTP status code from the failing response, when applicable. */
	readonly status: number | undefined;
	/** Server-defined `error` code string from the JSON body, when present. */
	readonly code: string | undefined;
	/**
	 * Raw parsed body (when JSON) or the response text (when not JSON).
	 * Useful for debugging unexpected error shapes.
	 */
	readonly body: unknown;

	constructor(
		message: string,
		options: { status?: number; code?: string; body?: unknown; cause?: unknown } = {}
	) {
		super(message, options.cause ? { cause: options.cause } : undefined);
		this.name = 'CanvasError';
		this.status = options.status;
		this.code = options.code;
		this.body = options.body;
	}
}

/**
 * Thrown when the server returns 429 with `error: "rate_limited"`.
 * Carries the `Retry-After` value (seconds) and the parsed
 * `X-RateLimit-*` headers so callers can implement client-side
 * back-off without re-reading headers.
 */
export class RateLimitError extends CanvasError {
	/** Seconds the client should wait before retrying. */
	readonly retryAfterSeconds: number;
	/** Parsed `X-RateLimit-*` headers. Each field is `null` when missing. */
	readonly rateLimit: RateLimitInfo;

	constructor(
		message: string,
		options: {
			retryAfterSeconds: number;
			rateLimit: RateLimitInfo;
			body?: unknown;
		}
	) {
		super(message, { status: 429, code: 'rate_limited', body: options.body });
		this.name = 'RateLimitError';
		this.retryAfterSeconds = options.retryAfterSeconds;
		this.rateLimit = options.rateLimit;
	}
}

/**
 * Thrown when the server returns `error: "quota_exceeded"`.
 *
 * The server currently reports this at HTTP 429 (it shares the
 * "you're over your allotment" status code with rate limits) — the
 * SDK disambiguates by inspecting the body's `error` code so the
 * caller catches the right type even though the status overlaps.
 */
export class QuotaExceededError extends CanvasError {
	/** The configured quota ceiling. `null` if the server didn't report it. */
	readonly limit: number | null;
	/** Current usage. `null` if the server didn't report it. */
	readonly current: number | null;

	constructor(
		message: string,
		options: { status: number; limit: number | null; current: number | null; body?: unknown }
	) {
		super(message, { status: options.status, code: 'quota_exceeded', body: options.body });
		this.name = 'QuotaExceededError';
		this.limit = options.limit;
		this.current = options.current;
	}
}

/**
 * Thrown when the server returns 404 with `error: "canvas_not_found"`.
 *
 * Either the slug/uuid doesn't exist OR it belongs to a different user
 * — the server collapses both into the same 404 to avoid leaking
 * existence. Callers should treat this as "no such canvas in your
 * account" rather than "no such canvas anywhere."
 */
export class CanvasNotFoundError extends CanvasError {
	constructor(message: string, options: { body?: unknown } = {}) {
		super(message, { status: 404, code: 'canvas_not_found', body: options.body });
		this.name = 'CanvasNotFoundError';
	}
}

/**
 * Thrown when the server rejects a request body / params with a 400.
 *
 * Covers `error: "invalid_param"` (with the offending `field`),
 * `"invalid_forward_url"`, and `"invalid_dpr"`. The `field` property
 * is populated for `invalid_param` and `null` for the others — the
 * server doesn't attach a field name to those.
 */
export class InvalidParamError extends CanvasError {
	/** Offending field name, when the server reports one. */
	readonly field: string | null;

	constructor(
		message: string,
		options: { code: string; field: string | null; body?: unknown }
	) {
		super(message, { status: 400, code: options.code, body: options.body });
		this.name = 'InvalidParamError';
		this.field = options.field;
	}
}
