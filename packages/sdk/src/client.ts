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

import type { RateLimitInfo } from './errors.js';
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

/** Forwarded shortId format — used by `get()` and `delete()`. */
function isValidShortId(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;
	// Reject anything that could escape the path segment. The server
	// itself enforces `[A-Za-z0-9_-]{10}` and 404s outliers, so
	// duplicating the regex here would just create drift if the
	// server changes its rules. The slash/?/# guard catches the
	// dangerous-input cases (path traversal, query injection) without
	// over-constraining future shortId schemes.
	return !/[/?#\\]/.test(trimmed);
}

/**
 * Full detail row returned by GET `/api/v1/renders/{shortId}` and
 * by each item in the GET `/api/v1/renders` list response. Richer
 * than `BakedRender` — carries the canvas join fields, dimensions,
 * and timestamp lifecycle.
 *
 * Note: `BakedRender` (the POST response) and `RenderDetail` (the
 * GET response) deliberately don't share a parent interface — POST
 * returns `deduplicated`, GET returns the join + dimensions, and
 * conflating them would require optional fields on every property.
 */
export interface RenderDetail {
	/** Short, opaque, URL-safe identifier. */
	id: string;
	/** Canonical share URL — `${baseUrl}/i/${id}`. */
	url: string;
	/** Direct image URL — `${baseUrl}/i/${id}/image.${ext}`. */
	imageUrl: string;
	/** UUID of the source canvas, or `null` if the canvas was deleted after render. */
	canvasId: string | null;
	/** Slug of the source canvas at GET time. `null` mirrors `canvasId`. */
	canvasSlug: string | null;
	/** Display name of the source canvas at GET time. `null` mirrors `canvasId`. */
	canvasName: string | null;
	/** Output format the renderer produced. */
	format: BakeFormat;
	/** Encoded byte size of the stored image. */
	sizeBytes: number;
	/** Image width in pixels. */
	width: number;
	/** Image height in pixels. */
	height: number;
	/** Resolved forward URL after param substitution, or `null` if none was set. */
	forwardUrl: string | null;
	/** Baked-in OpenGraph title for the `/i/{id}` share page. */
	ogTitle: string | null;
	/** Baked-in OpenGraph description for the `/i/{id}` share page. */
	ogDescription: string | null;
	/** ISO-8601 timestamp the row was created. */
	createdAt: string;
	/** ISO-8601 timestamp of the most recent `/i/{id}/image.{ext}` hit. */
	lastAccessedAt: string;
	/** ISO-8601 expiry timestamp, or `null` if the render has no TTL. */
	expiresAt: string | null;
}

/** Options for `client.list()`. */
export interface ListOptions {
	/**
	 * Filter to renders made from a specific canvas (slug or UUID).
	 * Cross-user references return an empty page rather than a 404.
	 */
	canvas?: string;
	/** Page size. Server enforces a max (rejects out-of-range with `invalid_limit`). */
	limit?: number;
	/** Opaque cursor from a previous response's `nextCursor`. */
	cursor?: string;
	/** Forwarded to `fetch` for caller-side cancellation. */
	signal?: AbortSignal;
}

/** Page of renders returned by `client.list()`. */
export interface RenderList {
	/** This page's items, newest first. */
	items: RenderDetail[];
	/** Cursor for the next page, or `null` when this is the last page. */
	nextCursor: string | null;
}

/**
 * Options for `client.signedUrl()` (stub — implementation lands in
 * [IDEA-205](https://github.com/xarmian/canvas)).
 *
 * Modeled as an exclusive union so callers can't supply neither or
 * both expiry forms — invalid call-sites surface as TypeScript
 * errors instead of runtime surprises (Codex round 1).
 *
 * @experimental Shape may change before IDEA-205 lands. Locked in
 *   here so callers can build code against the eventual surface
 *   without a breaking change at release time.
 */
export type SignedUrlOptions =
	| {
			/** Seconds until the signature expires. */
			expiresIn: number;
			expiresAt?: never;
	  }
	| {
			/** Absolute expiry timestamp (epoch ms OR ISO-8601 string). */
			expiresAt: number | string;
			expiresIn?: never;
	  };

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
	/**
	 * When `true` (default), a 429 response with body `error:
	 * "rate_limited"` triggers a single retry after honoring the
	 * `Retry-After` header. `quota_exceeded` responses (also at HTTP
	 * 429) are never retried — they're not transient. Set to `false`
	 * to surface every 429 immediately.
	 */
	retryOn429?: boolean;
	/**
	 * Maximum number of retries on retryable 429 responses. Default
	 * is `1` (so up to 2 attempts total). Set to `0` for no retries.
	 * Future versions may extend this to other retryable categories;
	 * the field is reserved for that.
	 */
	maxRetries?: number;
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
	/** Effective retry-on-429 setting (see config). */
	readonly retryOn429: boolean;
	/** Effective maxRetries setting (see config). */
	readonly maxRetries: number;
	/**
	 * Latest `X-RateLimit-Limit/-Remaining/-Reset` triplet parsed off
	 * the most recent response (success OR failure). `null` until the
	 * first response lands.
	 *
	 * Stripe-style "you have N requests left this window" UX without
	 * the caller having to re-parse headers. Updated by the SDK
	 * internals — treat it as read-only from outside.
	 */
	lastRateLimit: RateLimitInfo | null = null;

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
		if (
			config.maxRetries !== undefined &&
			(!Number.isInteger(config.maxRetries) || config.maxRetries < 0)
		) {
			throw new TypeError('CanvasClient: config.maxRetries must be a non-negative integer');
		}
		// Strip exactly one trailing slash. `client.image()` always
		// joins with a leading `/c/...`, so a normalized baseUrl
		// produces clean URLs regardless of operator preference.
		this.baseUrl = config.baseUrl.replace(/\/+$/, '');
		this.apiKey = config.apiKey;
		this.retryOn429 = config.retryOn429 ?? true;
		this.maxRetries = config.maxRetries ?? 1;
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

	/**
	 * List baked renders, newest first. Paginated via an opaque
	 * `nextCursor` — pass it back as `cursor` on the next call to get
	 * the following page.
	 *
	 * @example
	 *   let cursor: string | null = null;
	 *   do {
	 *     const page = await client.list({ canvas: 'og-card', limit: 50, cursor });
	 *     for (const item of page.items) console.log(item.id);
	 *     cursor = page.nextCursor;
	 *   } while (cursor !== null);
	 */
	async list(opts: ListOptions = {}): Promise<RenderList> {
		const { data } = await request<RenderList>(this, {
			method: 'GET',
			path: '/api/v1/renders',
			query: {
				canvas: opts.canvas,
				limit: opts.limit,
				cursor: opts.cursor
			},
			signal: opts.signal
		});
		return data;
	}

	/**
	 * Fetch a single render's full detail by its short id.
	 *
	 * @throws `TypeError` when `shortId` is empty or contains
	 *   path-unsafe characters (`/`, `?`, `#`, `\`).
	 * @throws `CanvasNotFoundError` when the id doesn't exist, is
	 *   soft-deleted, or belongs to a different user. The server
	 *   collapses all three into the same 404 to avoid leaking
	 *   existence.
	 */
	async get(shortId: string, opts: { signal?: AbortSignal } = {}): Promise<RenderDetail> {
		if (!isValidShortId(shortId)) {
			throw new TypeError(`CanvasClient.get: shortId must be a non-empty path-safe string`);
		}
		const { data } = await request<RenderDetail>(this, {
			method: 'GET',
			path: `/api/v1/renders/${encodeURIComponent(shortId.trim())}`,
			signal: opts.signal
		});
		return data;
	}

	/**
	 * Soft-delete a render by its short id. The DB row is marked
	 * deleted immediately; storage cleanup is best-effort on the
	 * server side and converges via the sweep CLI.
	 *
	 * **Not idempotent across calls** — a second DELETE on the same
	 * id 404s. Catch `CanvasNotFoundError` if you need idempotent
	 * deletion semantics.
	 *
	 * @throws `TypeError` when `shortId` is empty or path-unsafe.
	 * @throws `CanvasNotFoundError` on 404 (id missing or already
	 *   deleted).
	 */
	async delete(shortId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
		if (!isValidShortId(shortId)) {
			throw new TypeError(`CanvasClient.delete: shortId must be a non-empty path-safe string`);
		}
		await request<void>(this, {
			method: 'DELETE',
			path: `/api/v1/renders/${encodeURIComponent(shortId.trim())}`,
			signal: opts.signal
		});
	}

	/**
	 * Build a signed, time-limited image URL.
	 *
	 * @experimental **Not yet implemented.** This method is a typed
	 *   placeholder for the surface that lands in
	 *   [IDEA-205](https://github.com/xarmian/canvas) (Signed-URL
	 *   endpoint + SDK helper). It throws at runtime so consumers
	 *   can see the eventual shape now and write call-sites that
	 *   won't need to change when the implementation arrives.
	 *
	 *   Exact semantics of `expiresIn` vs `expiresAt`, the
	 *   signature algorithm, and the resulting URL format are all
	 *   subject to IDEA-205's design.
	 *
	 * @throws Always throws `Error('signedUrl is not yet implemented
	 *   — see IDEA-205')`.
	 */
	signedUrl(
		_slug: string,
		_params: ImageParams,
		_opts: SignedUrlOptions
	): Promise<string> {
		// Throw inside an async-returning function via a rejected
		// Promise so callers using `await` see a rejection instead of
		// a synchronous throw. Matches the eventual real
		// implementation's contract (signing is async — likely Web
		// Crypto under the hood).
		return Promise.reject(
			new Error('signedUrl is not yet implemented — see IDEA-205')
		);
	}
}
