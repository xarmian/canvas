---
'@canvas-images/sdk': minor
---

Initial public release. TypeScript client for the Canvas Render API — self-host friendly, ESM-first, edge-safe, ~2.7 KB gzipped.

Surface:

- `CanvasClient` constructor with `baseUrl`, `apiKey`, retry config.
- `client.image(slug, params?)` — synchronous URL builder for the on-the-fly render route. No network, no auth.
- `client.bake(slug, params?, opts?)` — POST to `/api/v1/renders`, returns `BakedRender` permalink metadata.
- `client.list(opts?)` / `client.get(shortId)` / `client.delete(shortId)` — paginated read, single read, soft-delete.
- `client.signedUrl(slug, params, opts)` — typed stub for the IDEA-205 signed-URL helper. Throws at runtime; locks the surface so the eventual implementation isn't a breaking change.
- Typed errors: `CanvasError` base + `RateLimitError` / `QuotaExceededError` / `CanvasNotFoundError` / `InvalidParamError`. Body-code disambiguation so `quota_exceeded` (also HTTP 429) is reliably distinct from `rate_limited`.
- `client.lastRateLimit` populated from `X-RateLimit-*` headers on every response (success + failure).
- Auto-retry on transient 429s with `Retry-After` honored (both RFC 9110 forms: delta-seconds and HTTP-date). Cancellable via `AbortSignal`. `quota_exceeded` never retried.
- ESM + CJS dual build with per-format `.d.ts` / `.d.cts`.

Hardened in CI:

- Bundle-size budget enforced at <5 KB min+gzip (size-limit).
- Three-layer "no Node-only deps" defense: source scan, tsup `platform: 'neutral'` build, edge-runtime bundle smoke under workerd-compatible esbuild config.
- 174 unit tests covering URL parity, every error mapping, retry policy, rate-limit surfacing, signedUrl stub contract, and import hygiene.
