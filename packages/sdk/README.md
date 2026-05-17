# @canvas-images/sdk

> **Status: scaffold only.** The client surface lands in TASK-219+ under PLAN-216.

A small, ESM-first, edge-safe TypeScript client for the [Canvas](https://github.com/xarmian/canvas) Render API.

## Planned surface

```ts
import { CanvasClient } from '@canvas-images/sdk';

const client = new CanvasClient({
	baseUrl: 'https://canvas.example.com',
	apiKey: process.env.CANVAS_API_KEY
});

// On-the-fly URL — cacheable, no DB row. Returns a URL string.
const url = client.image('og-card', { title: 'Hello' });

// Baked render — POSTs, returns the permalink + metadata.
const result = await client.bake('og-card', { title: 'Hello' });
```

## Design constraints

- **ESM first, CJS shim.** Works in Vite / Next / Edge runtimes out of the box.
- **No Node-only deps.** Default path uses Web Crypto.
- **Small bundle.** **<5 KB min+gzip** for the full client surface, enforced in CI via [size-limit](https://github.com/ai/size-limit) — see [`.size-limit.cjs`](./.size-limit.cjs). Current measurement: ~2.65 KB gzipped.
- **Self-host friendly.** `baseUrl` required; no hosted-tier assumption.
- **Typed errors.** `RateLimitError`, `QuotaExceededError`, `CanvasNotFoundError`, `InvalidParamError`.

### A note on tree-shaking

The SDK is class-based (`CanvasClient`), so a consumer importing the class brings every method along — bundlers can't tree-shake unused class methods, full stop. In practice this means an app that only calls `client.image()` ships the same ~2.65 KB as one that uses `bake/list/get/delete`. The 5 KB ceiling covers the whole surface; if a tighter "image-only" budget ever matters, the path is to split `image()` into a standalone function or a subpath export (`@canvas-images/sdk/image`).

## License

MIT.
