# @canvas-images/sdk

> TypeScript client for the [Canvas](https://github.com/xarmian/canvas) Render API. Self-host friendly, ESM-first, edge-safe, ~2.7 KB gzipped.

## Install

```bash
pnpm add @canvas-images/sdk
# or
npm install @canvas-images/sdk
# or
yarn add @canvas-images/sdk
```

Requires **Node 18+** (or any modern Edge runtime — Cloudflare Workers, Vercel Edge, Deno, browsers).

## Quickstart

```ts
import { CanvasClient } from '@canvas-images/sdk';

const client = new CanvasClient({
	baseUrl: 'https://canvas.example.com',
	apiKey: process.env.CANVAS_API_KEY
});

// On-the-fly URL — synchronous, no roundtrip. Returns a string.
const url = client.image('og-card', { title: 'Hello world' });
// → "https://canvas.example.com/c/og-card/image.png?title=Hello+world"

// Baked render — POSTs, returns the permalink + metadata.
const result = await client.bake('og-card', { title: 'Hello world' });
// → { id: 'abc123', url: '.../i/abc123', imageUrl: '.../image.png', ... }
```

That's it. The `image()` URL builder needs no auth and works offline; `bake()` and the read/delete methods authenticate via the bearer token from `apiKey`.

## Config

```ts
new CanvasClient({
	baseUrl: string;        // required — Canvas instance, e.g. https://canvas.example.com
	apiKey?: string;        // optional — required for bake / list / get / delete
	retryOn429?: boolean;   // default true — auto-retry transient rate-limit responses
	maxRetries?: number;    // default 1 — non-negative integer; 0 disables retries
});
```

- `baseUrl` is validated as a parseable URL and normalized (trailing slashes stripped). Path prefixes are preserved (`https://example.com/canvas` works).
- `apiKey` is only needed for the authenticated methods. `image()` works without one.
- `retryOn429` controls auto-retry on `rate_limited` 429 responses. `quota_exceeded` (also a 429) is **never** retried — it's a hard ceiling.
- `maxRetries: 0` short-circuits the retry loop. The constructor rejects non-integer or negative values with `TypeError`.

## Methods

### `client.image(slug, params?)`

**Synchronous URL builder.** No network call, no auth. Returns the fully-built URL string.

```ts
client.image('og-card', { title: 'Hello' });
// → "https://canvas.example.com/c/og-card/image.png?title=Hello"
```

- `params` values are coerced to strings via `String(v)`. Numbers and booleans become `"42"` / `"true"`. `null` and `undefined` are dropped silently.
- Param encoding matches the server's `URLSearchParams` parser exactly — verified by round-trip parity tests against the Render route.

### `client.bake(slug, params?, opts?)`

**Async render POST.** Submits a baked-render request to `/api/v1/renders` and returns the permalink metadata.

```ts
const result = await client.bake('og-card', { title: 'Hello' }, {
	format: 'webp',          // 'png' | 'jpeg' | 'webp' | 'avif' — default 'png'
	forwardUrl: 'https://example.com/promo',
	ogTitle: 'Promo title',
	ogDescription: 'Description for share cards',
	dpr: 2,                  // 1 | 2 | 3 — default 1
	signal: controller.signal // optional AbortSignal
});
// result: BakedRender — { id, url, imageUrl, forwardUrl, deduplicated, createdAt }
```

`deduplicated: true` indicates the server returned an existing identical render (HTTP 200) instead of creating a new one (HTTP 201). The URL / id is the same either way.

### `client.list(opts?)`

Paginated read of your renders, newest first.

```ts
const page = await client.list({
	canvas: 'og-card',  // optional — filter to one canvas (slug or uuid)
	limit: 50,          // optional — page size; server enforces a max
	cursor: prev.nextCursor, // opaque, from a previous response
	signal: controller.signal
});
// page: { items: RenderDetail[], nextCursor: string | null }
```

`RenderDetail` carries everything `BakedRender` does plus the canvas join (`canvasId`, `canvasSlug`, `canvasName`), dimensions (`sizeBytes`, `width`, `height`), and lifecycle timestamps (`lastAccessedAt`, `expiresAt`).

### `client.get(shortId, opts?)`

Single-render detail by short id.

```ts
const detail = await client.get('abc123xyz0');
// → RenderDetail
```

Throws `CanvasNotFoundError` on 404 (the server collapses "doesn't exist", "wrong owner", and "soft-deleted" into a single 404 to avoid leaking existence).

### `client.delete(shortId, opts?)`

Soft-delete a render.

```ts
await client.delete('abc123xyz0');
// → undefined on 204; throws CanvasNotFoundError on 404
```

**Not idempotent across calls** — a second DELETE on the same id 404s. Catch `CanvasNotFoundError` if you need idempotent semantics.

### `client.signedUrl(slug, params, opts)`

> **🚧 Experimental — not yet implemented.** Throws at runtime. The typed surface is locked in so call-sites won't need to change when the implementation lands.

```ts
// When implemented:
await client.signedUrl('og-card', { title: 'Hello' }, { expiresIn: 3600 });
```

`SignedUrlOptions` is an exclusive union — supply exactly one of `expiresIn` (seconds from now) OR `expiresAt` (epoch ms or ISO-8601 string).

## Errors

All errors raised from server responses extend `CanvasError`. Catch the base for "anything the SDK threw," catch a subclass for specific cases:

```ts
import {
	CanvasError,
	CanvasNotFoundError,
	InvalidParamError,
	QuotaExceededError,
	RateLimitError
} from '@canvas-images/sdk';

try {
	await client.bake('og-card', { title: 'Hi' });
} catch (err) {
	if (err instanceof RateLimitError) {
		// Already auto-retried once by default; this is the second 429.
		console.log(`Backing off ${err.retryAfterSeconds}s`);
	} else if (err instanceof QuotaExceededError) {
		console.log(`Quota: ${err.current}/${err.limit}`);
	} else if (err instanceof CanvasNotFoundError) {
		// 404 — canvas missing or owned by another user
	} else if (err instanceof InvalidParamError) {
		console.log(`Bad param '${err.field}': ${err.message}`);
	} else if (err instanceof CanvasError) {
		// 5xx, network failure, or anything else
		console.log(`HTTP ${err.status}: ${err.message}`);
	}
}
```

| Class | Raised when | Notable fields |
|---|---|---|
| `CanvasError` | base — 5xx, network failures, or any non-2xx with no narrower mapping | `status`, `code`, `body`, `cause` |
| `RateLimitError` | server returns `error: "rate_limited"` (HTTP 429) | `retryAfterSeconds`, `rateLimit` |
| `QuotaExceededError` | server returns `error: "quota_exceeded"` (HTTP 429) | `limit`, `current` |
| `CanvasNotFoundError` | 404 on `bake` / `get` / `delete` | (inherits `body`) |
| `InvalidParamError` | HTTP 400 (any `invalid_*` code) | `code`, `field`, `message` |

Server emits **both** `rate_limited` and `quota_exceeded` at HTTP 429 — the SDK disambiguates via the body's `error` code so `err instanceof RateLimitError` and `err instanceof QuotaExceededError` are reliably distinct.

Configuration errors (missing `apiKey` when required, invalid `baseUrl`, invalid `maxRetries`) throw `TypeError` instead of `CanvasError` — they're caller mistakes, not API outcomes.

## Rate limiting

Every response — success **or** failure — updates `client.lastRateLimit` with the parsed `X-RateLimit-*` triplet:

```ts
await client.bake('og-card');
console.log(client.lastRateLimit);
// → { limit: 60, remaining: 42, resetSeconds: 17 }
// (any field is `null` if the server didn't send the header)
```

Stripe-style "you have N requests left this window" UX without re-parsing headers in your own catch blocks.

### Auto-retry on 429

By default, a single retryable 429 triggers one retry after honoring `Retry-After`:

- **`error: "rate_limited"`** (or a bare 429 with no body code) → retried once. If the retry also fails, throws `RateLimitError`.
- **`error: "quota_exceeded"`** → **never retried.** It's a hard ceiling, not a transient throttle. Throws `QuotaExceededError` immediately.

`Retry-After` accepts both RFC 9110 forms: delta-seconds (`Retry-After: 12`) and HTTP-date (`Retry-After: Sun, 17 May 2026 14:23:00 GMT`). Defaults to 1 second when the header is missing or unparseable.

The retry wait is **cancellable** — pass an `AbortSignal` and aborting mid-wait throws `CanvasError` cleanly without firing the retry.

To disable retries entirely or extend the cap:

```ts
new CanvasClient({ baseUrl, apiKey, retryOn429: false });        // disabled
new CanvasClient({ baseUrl, apiKey, maxRetries: 0 });            // also disabled
new CanvasClient({ baseUrl, apiKey, maxRetries: 3 });            // up to 4 total attempts
```

## Edge runtimes

The SDK is **node-free**. It runs unmodified on:

- **Cloudflare Workers** / **Vercel Edge** / Deno
- Browsers (any modern bundler)
- Node 18+

Uses only Web Crypto + Fetch + URL APIs. No polyfills required.

Hardened by a three-layer defense in CI:

1. **Source scan** — every `src/**/*.ts` rejected for `node:*` imports or Node globals (`process.*`, `Buffer`, `__dirname`, etc.).
2. **Build config** — `tsup` builds with `platform: 'neutral'`, so any node-only import in source or transitive deps fails the build.
3. **Bundle smoke** — a minimal Cloudflare Worker fetch handler is bundled via esbuild with workerd-compatible config on every PR, and the published `dist/index.js` is grepped for `node:*` specifiers as a final tripwire.

## Bundle size

**< 5 KB min+gzip** for the full client surface, enforced in CI via [size-limit](https://github.com/ai/size-limit) — see [`.size-limit.cjs`](./.size-limit.cjs). Current measurement: **~2.7 KB gzipped**.

### A note on tree-shaking

`CanvasClient` is class-based, so bundlers can't drop unused methods even with `sideEffects: false`. An app that only calls `client.image()` ships the same ~2.7 KB as one that uses every method. The 5 KB ceiling covers the whole surface; if a tighter "image-only" budget ever matters, the path is to extract `image()` into a standalone function or a subpath export (`@canvas-images/sdk/image`).

## Examples

- **[`examples/nextjs-og-cards/`](../../examples/nextjs-og-cards/)** — Next.js 14 (app router) example using `client.image()` from `generateMetadata()` to set `openGraph.images` per blog post. The crawler fetches the Canvas URL directly; Next.js never proxies bytes.

## TypeScript

Ships ES module + CommonJS builds with per-format `.d.ts` / `.d.cts` so TypeScript's `moduleResolution: bundler`/`node16` resolves the right declarations under both module systems. `sideEffects: false`, `engines.node: >=18`.

## License

MIT.
