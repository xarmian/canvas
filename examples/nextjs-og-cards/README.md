# nextjs-og-cards — Next.js 14 + @canvas-images/sdk

A minimal Next.js 14 (app router) example that uses [`@canvas-images/sdk`](../../packages/sdk) to render dynamic OG card images per blog post.

## What it shows

- **`generateMetadata()` per post** sets `openGraph.images` to a URL built by `client.image()`. The social-media crawler fetches that URL directly from your Canvas instance — Next.js never proxies the bytes.
- **Sync URL builder** (`client.image()`) is the only SDK method this example needs. No auth, no roundtrip, no async.
- **Index page** prints the built URL for each post (inside a `<details>` block) so you can see what gets emitted.

## 60-second setup

This example is part of the [Canvas monorepo](../../) and uses the workspace-linked SDK via `workspace:*`.

```bash
# From the repo root:
pnpm install            # installs the example + workspace-links the SDK

# Configure your Canvas instance:
cp examples/nextjs-og-cards/.env.example examples/nextjs-og-cards/.env.local
# edit CANVAS_BASE_URL to point at your instance

# Run it:
pnpm --filter nextjs-og-cards dev
# → http://localhost:3000
```

> **Heads up:** without `CANVAS_BASE_URL` set, the example builds and serves but the OG image URLs point at `canvas.example.com` and won't actually resolve. You'll see the URL strings on the index page but no rendered images.

## Canvas requirements

For the OG images to actually render against your instance, define a canvas with:

- **slug:** `og-card`
- **params:** `title` (string) and `subtitle` (string)
- **published:** true

The exact rendering logic (fonts, layout, dimensions) is yours — the SDK just builds the right URL; the Canvas server does the rendering.

## Files worth reading

| Path | What it does |
|---|---|
| `lib/client.ts` | Constructs the shared `CanvasClient` from env vars. |
| `lib/posts.ts` | Fixture posts (no DB — the example is about the OG pipeline). |
| `app/page.tsx` | Index page. Shows each post + its built OG URL for inspection. |
| `app/blog/[slug]/page.tsx` | Per-post page. `generateMetadata()` builds the OG URL via `client.image()` and feeds it to `openGraph.images`. |

## Beyond this example

The same `CanvasClient` exposes the async methods too:

```ts
// One-time bake — store the rendered image at a stable short URL,
// useful for share links that shouldn't change.
const baked = await client.bake('og-card', { title: post.title });
// → { id, url, imageUrl, ... }

// List your renders.
const page = await client.list({ canvas: 'og-card', limit: 50 });

// Look up a single render's metadata.
const detail = await client.get('abc123xyz0');

// Soft-delete.
await client.delete('abc123xyz0');
```

See [`packages/sdk/README.md`](../../packages/sdk/README.md) for the full API reference, error types, rate-limit handling, and edge-runtime guarantees.

## License

MIT (same as the SDK and the rest of the monorepo).
