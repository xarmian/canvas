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
import { throwFromResponse } from './from-response.js';

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

	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (err) {
		// `fetch` throws on DNS failure, TCP reset, CORS preflight
		// rejection, AbortSignal trips — every reason that doesn't
		// produce a `Response`. Wrap so consumers only have one error
		// hierarchy to catch. Preserve the original via `cause`.
		throw new CanvasError(
			err instanceof Error ? `Network request failed: ${err.message}` : 'Network request failed.',
			{ cause: err }
		);
	}

	if (!response.ok) {
		await throwFromResponse(response);
	}

	// Empty body (204 No Content, or an endpoint that returns nothing
	// on success) yields `undefined` cast as T — callers that ask for
	// `void` get sensible semantics, and DELETE-style operations don't
	// need a fake JSON body server-side.
	const text = await response.text();
	const data = (text.length > 0 ? (JSON.parse(text) as T) : (undefined as T));
	return { data, response };
}
