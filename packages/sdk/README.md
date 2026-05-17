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
- **Tree-shakeable.** A consumer using only `client.image(...)` shouldn't pay for the baked-render code path.
- **Small bundle.** Target <5kb min+gzip for the core.
- **Self-host friendly.** `baseUrl` required; no hosted-tier assumption.
- **Typed errors.** `RateLimitError`, `QuotaExceededError`, `CanvasNotFoundError`, `InvalidParamError`.

## License

MIT.
