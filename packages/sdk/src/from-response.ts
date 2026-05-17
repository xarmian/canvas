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
function extractCode(body: unknown): string | undefined {
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
 * 4. **`code === 'invalid_param' | 'invalid_forward_url' | 'invalid_dpr'`**
 *    → `InvalidParamError`.
 * 5. Status-only fallbacks: 404 → `CanvasNotFoundError`, 429 → generic
 *    `RateLimitError`, 400 → generic `InvalidParamError`.
 * 6. Otherwise → base `CanvasError`.
 *
 * The caller is responsible for only invoking this when `!res.ok` —
 * `throwFromResponse(okResponse)` would build an error from a 2xx body
 * which is almost certainly a bug.
 */
export async function throwFromResponse(res: Response): Promise<never> {
	const body = await readBody(res);
	const code = extractCode(body);

	// 1. Rate limit — anchored on body code, not status, so a future
	//    server change that moves rate_limited to 503 still surfaces
	//    as RateLimitError.
	if (code === 'rate_limited') {
		// `retryAfterSeconds` comes from the body, but fall back to the
		// `Retry-After` header (also set by the server) so a malformed
		// body still produces a usable error.
		const retryAfter =
			readNumberField(body, 'retryAfterSeconds') ?? readIntHeader(res.headers, 'Retry-After');
		throw new RateLimitError(
			retryAfter !== null
				? `Rate limit exceeded; retry after ${retryAfter}s.`
				: 'Rate limit exceeded.',
			{
				retryAfterSeconds: retryAfter ?? 0,
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

	// 4. Invalid-param family. `invalid_param` is the only variant that
	//    carries a `field`; the other two come with just a `message`.
	if (code === 'invalid_param' || code === 'invalid_forward_url' || code === 'invalid_dpr') {
		const field = readStringField(body, 'field');
		const message =
			readStringField(body, 'message') ??
			(code === 'invalid_param'
				? 'Invalid render param.'
				: code === 'invalid_forward_url'
					? 'Invalid forwardUrl.'
					: 'Invalid dpr.');
		throw new InvalidParamError(message, { code, field, body });
	}

	// 5. Status-only fallbacks for unknown body codes.
	if (res.status === 404) {
		throw new CanvasNotFoundError('Canvas not found or not accessible.', { body });
	}
	if (res.status === 429) {
		throw new RateLimitError('Rate limit exceeded.', {
			retryAfterSeconds: readIntHeader(res.headers, 'Retry-After') ?? 0,
			rateLimit: parseRateLimitHeaders(res.headers),
			body
		});
	}
	if (res.status === 400) {
		throw new InvalidParamError('Invalid request.', {
			code: code ?? 'invalid_request',
			field: null,
			body
		});
	}

	// 6. Everything else — base CanvasError.
	throw new CanvasError(
		`Canvas API request failed (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}).`,
		{ status: res.status, code, body }
	);
}
