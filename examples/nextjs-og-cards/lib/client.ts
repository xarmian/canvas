/**
 * Shared `CanvasClient` instance, configured from env vars.
 *
 * Reads `CANVAS_BASE_URL` (defaults to `canvas.example.com` so the
 * example builds without setup — but the OG images won't actually
 * resolve until this is pointed at a real instance with an
 * `og-card` canvas defined).
 */
import { CanvasClient } from '@canvas-images/sdk';

const baseUrl = process.env.CANVAS_BASE_URL ?? 'https://canvas.example.com';

export const client = new CanvasClient({
	baseUrl,
	// `image()` (the only method this example uses today) doesn't need
	// auth. If you extend the example to call `bake()` / `list()` /
	// etc., set CANVAS_API_KEY in `.env.local`.
	apiKey: process.env.CANVAS_API_KEY
});
