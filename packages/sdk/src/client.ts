/**
 * `CanvasClient` — TypeScript entry point for the Canvas Render API.
 *
 * This module ships the constructor + the synchronous URL builder
 * `client.image()`. Async methods (`bake`, `list`, `get`, `delete`)
 * land in TASK-220+ under PLAN-216.
 */

/**
 * Values that can be passed as a render param.
 *
 * - Strings, numbers, and booleans serialize via `String(value)` and ride
 *   in the query string. Booleans become `"true"` / `"false"` — matching
 *   the server's lenient param parser.
 * - `null` and `undefined` are dropped silently. This lets a caller pass
 *   conditional params from a wider object without an extra filter step.
 *
 * The server route under `/c/{slug}/image.{ext}` walks
 * `url.searchParams` and forwards every non-underscore key to the
 * renderer, so anything `URLSearchParams` can encode is accepted.
 */
export type ImageParamValue = string | number | boolean | null | undefined;

/** A bag of render params, keyed by canvas param name. */
export type ImageParams = Record<string, ImageParamValue>;

/** Construction options for a `CanvasClient`. */
export interface CanvasClientConfig {
	/**
	 * Base URL of the Canvas instance. May or may not include a path
	 * prefix (e.g. `https://canvas.example.com`, `https://example.com/canvas`).
	 * A trailing slash is tolerated and normalized away.
	 */
	baseUrl: string;
	/**
	 * Optional API key. Not used by `image()` (the public render route is
	 * unauthenticated), but accepted here so a single client instance can
	 * cover both `image()` and the upcoming authenticated methods
	 * (`bake`, `list`, etc.).
	 */
	apiKey?: string;
}

/**
 * Type guard: rejects empty strings, whitespace-only strings, and
 * obvious path-traversal attempts. The server validates slugs against
 * its own canvas table, but a client-side check fails fast on the
 * common mistakes (typos, undefined-as-string).
 */
function isValidSlug(value: string): boolean {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;
	// Slugs in the existing schema are letters / digits / dashes /
	// underscores. Reject anything with a path separator or query
	// delimiter outright so a typo can't smuggle data into the path
	// portion of the URL.
	return !/[/?#\\]/.test(trimmed);
}

/**
 * The Canvas SDK client.
 *
 * Today it exposes:
 *
 * - `image(slug, params)` — synchronous URL builder for the
 *   on-the-fly render route. No network call, no auth.
 *
 * The rest of the public surface (`bake`, `list`, `get`, `delete`,
 * `signedUrl`, typed errors, rate-limit surfacing) lands in TASK-220+.
 */
export class CanvasClient {
	/** Normalized base URL with any trailing slash removed. */
	readonly baseUrl: string;
	/** API key from config, or `undefined` if none was provided. */
	readonly apiKey: string | undefined;

	constructor(config: CanvasClientConfig) {
		if (!config || typeof config !== 'object') {
			throw new TypeError('CanvasClient: config object is required');
		}
		if (typeof config.baseUrl !== 'string' || config.baseUrl.trim().length === 0) {
			throw new TypeError('CanvasClient: config.baseUrl must be a non-empty string');
		}
		// Validate that baseUrl is a parseable URL — fail-fast on
		// typos like `canvas.example.com` (missing protocol).
		try {
			new URL(config.baseUrl);
		} catch {
			throw new TypeError(
				`CanvasClient: config.baseUrl is not a valid URL: ${config.baseUrl}`
			);
		}
		// Strip exactly one trailing slash. `client.image()` always
		// joins with a leading `/c/...`, so a normalized baseUrl
		// produces clean URLs regardless of operator preference.
		this.baseUrl = config.baseUrl.replace(/\/+$/, '');
		this.apiKey = config.apiKey;
	}

	/**
	 * Build a URL for the on-the-fly render route. Synchronous — does not
	 * hit the network.
	 *
	 * @param slug - Canvas slug (the part after `/c/` in the URL).
	 * @param params - Render params keyed by canvas param name. `null`
	 *   and `undefined` values are skipped; everything else is coerced
	 *   to a string.
	 * @returns The fully-built URL as a string.
	 *
	 * @example
	 *   const url = client.image('og-card', { title: 'Hello', subtitle: undefined });
	 *   // → "https://canvas.example.com/c/og-card/image.png?title=Hello"
	 */
	image(slug: string, params: ImageParams = {}): string {
		if (!isValidSlug(slug)) {
			throw new TypeError(`CanvasClient.image: slug must be a non-empty path-safe string`);
		}
		// `encodeURIComponent` over the slug guards against characters
		// the server's path matcher would refuse anyway, but the slug
		// validator above already rejects `/`, `?`, `#`, `\`. The
		// encode call still handles spaces and unicode safely.
		const path = `/c/${encodeURIComponent(slug.trim())}/image.png`;

		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value === null || value === undefined) continue;
			// Cast to string explicitly so URLSearchParams doesn't trip
			// on `Symbol` or other exotic inputs. `String(true)` is
			// `"true"`, matching what the server expects for booleans.
			search.set(key, String(value));
		}

		const query = search.toString();
		return query.length > 0 ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;
	}
}
