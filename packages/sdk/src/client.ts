/**
 * `CanvasClient` — TypeScript entry point for the Canvas Render API.
 *
 * Current surface:
 *
 * - `image(slug, params)` — synchronous URL builder for the
 *   on-the-fly render route (no network, no auth).
 * - `bake(slug, params, opts?)` — POST `/api/v1/renders` with bearer
 *   auth, returns the permalink metadata.
 *
 * `list`, `get`, `delete` land in TASK-221. Rate-limit surfacing
 * (`client.lastRateLimit`) lands in TASK-223.
 */

import { request } from './request.js';

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

/**
 * Output format for `bake()`. Mirrors the server's `ALLOWED_FORMATS`
 * (apps/web/src/routes/api/v1/renders/+server.ts).
 */
export type BakeFormat = 'png' | 'jpeg' | 'webp' | 'avif';

/** Optional render-level options for `bake()`. All fields default to the server's default. */
export interface BakeOptions {
	/** Output format. Server default is `'png'`. */
	format?: BakeFormat;
	/**
	 * URL the `/i/{shortId}` interstitial CTA should forward to.
	 * Must resolve to http or https after param substitution.
	 * Pass `null` (or omit) to skip the forward.
	 */
	forwardUrl?: string | null;
	/** OpenGraph title baked into the share-page HTML. */
	ogTitle?: string | null;
	/** OpenGraph description baked into the share-page HTML. */
	ogDescription?: string | null;
	/** Device-pixel ratio. Server accepts 1, 2, or 3. */
	dpr?: 1 | 2 | 3;
	/** Forwarded to `fetch` for caller-side cancellation. */
	signal?: AbortSignal;
}

/**
 * Response shape from POST `/api/v1/renders` (and the dedup-hit
 * 200 variant). Mirrors what the server actually emits.
 */
export interface BakedRender {
	/** Short, opaque, URL-safe identifier. */
	id: string;
	/** Canonical share URL — `${baseUrl}/i/${id}`. */
	url: string;
	/** Direct image URL — `${baseUrl}/i/${id}/image.${ext}`. */
	imageUrl: string;
	/** Resolved forward URL after param substitution, or `null` if none was set. */
	forwardUrl: string | null;
	/**
	 * `true` when the render was deduplicated against an existing row
	 * (HTTP 200), `false` when a new row was created (HTTP 201).
	 */
	deduplicated: boolean;
	/** ISO-8601 timestamp of when the underlying row was first created. */
	createdAt: string;
}

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

	/**
	 * Bake a render. POSTs to `/api/v1/renders` with bearer auth,
	 * returns the permalink metadata. Two success shapes share the
	 * same `BakedRender` interface — the server emits HTTP 201 with
	 * `deduplicated: false` for a newly-created row and HTTP 200 with
	 * `deduplicated: true` when a previous identical request is
	 * found in the dedup index.
	 *
	 * @throws `TypeError` when the client was constructed without
	 *   `apiKey`.
	 * @throws `InvalidParamError` on 400 (bad canvas, bad param,
	 *   bad format, etc.).
	 * @throws `CanvasNotFoundError` on 404 (canvas missing or owned
	 *   by another user).
	 * @throws `RateLimitError` on 429 with `error: "rate_limited"`.
	 * @throws `QuotaExceededError` on 429 with `error: "quota_exceeded"`.
	 * @throws `CanvasError` for any other failure (5xx, network).
	 *
	 * @example
	 *   const result = await client.bake('og-card', { title: 'Hello' });
	 *   // → { id: 'abc123', url: '.../i/abc123', imageUrl: '.../image.png',
	 *   //    forwardUrl: null, deduplicated: false, createdAt: '...' }
	 */
	async bake(
		slug: string,
		params: ImageParams = {},
		opts: BakeOptions = {}
	): Promise<BakedRender> {
		if (typeof slug !== 'string' || slug.trim().length === 0) {
			throw new TypeError('CanvasClient.bake: slug must be a non-empty string');
		}

		// Server expects every param value to be a string. Reuse the
		// `image()` coercion rules (null/undefined dropped, everything
		// else coerced via `String(v)`) so a single object shape feeds
		// both the URL builder and the bake endpoint.
		//
		// Use a null-prototype object so a computed `'__proto__'` key
		// becomes a normal own property instead of mutating the
		// prototype chain (which would silently drop the param from
		// JSON.stringify). `image()` is unaffected because
		// URLSearchParams.set() handles `__proto__` as a regular key.
		const stringParams: Record<string, string> = Object.create(null);
		for (const [key, value] of Object.entries(params)) {
			if (value === null || value === undefined) continue;
			stringParams[key] = String(value);
		}

		// Build the request body. The server rejects unknown fields
		// with `error: "unknown_field"`, so we only include keys the
		// caller actually set (no `format: undefined`).
		const body: Record<string, unknown> = {
			canvas: slug.trim(),
			params: stringParams
		};
		if (opts.format !== undefined) body.format = opts.format;
		if (opts.forwardUrl !== undefined) body.forwardUrl = opts.forwardUrl;
		if (opts.ogTitle !== undefined) body.ogTitle = opts.ogTitle;
		if (opts.ogDescription !== undefined) body.ogDescription = opts.ogDescription;
		if (opts.dpr !== undefined) body.dpr = opts.dpr;

		const { data } = await request<BakedRender>(this, {
			method: 'POST',
			path: '/api/v1/renders',
			body,
			signal: opts.signal
		});
		return data;
	}
}
