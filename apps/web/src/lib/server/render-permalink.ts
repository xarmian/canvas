/**
 * Helpers shared by the POST and read-side handlers under `/api/v1/renders`.
 *
 * Centralized so the response payload — share URL, image URL, canvas ref
 * fields — stays identical across endpoints. Integrators can rely on a
 * uniform shape regardless of whether they're parsing the POST result,
 * the list-detail GET, or a webhook callback (future).
 */
import { env as publicEnv } from '$env/dynamic/public';
import { FORMAT_EXTENSIONS } from './baked-render';
import type { OutputFormat } from '$lib/engine';

/**
 * Return the public origin used to construct `/i/{shortId}` permalinks.
 * Resolution order:
 *   1. `PUBLIC_APP_URL` env (with trailing slash stripped) — used by
 *      operators behind a reverse proxy where the request `Host` header
 *      isn't the canonical user-facing origin.
 *   2. The request origin as a sensible fallback for dev / single-host
 *      deployments.
 */
export function publicAppOrigin(requestOrigin: string): string {
	// `$env/dynamic/public` keys not present at build time narrow to
	// `never`, so reach via bracket access — the type model is fine with
	// that, and the runtime is identical.
	const raw = (publicEnv as Record<string, string | undefined>).PUBLIC_APP_URL?.trim();
	if (!raw) return requestOrigin;
	return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** Build the public share-page URL for a baked render. */
export function shareUrlFor(appOrigin: string, shortId: string): string {
	return `${appOrigin}/i/${shortId}`;
}

/** Build the app-proxied image URL for a baked render. Defaults to PNG
 *  when the format is somehow unknown (e.g. row written before a new
 *  format was supported — defensive, never expected in practice). */
export function imageUrlFor(appOrigin: string, shortId: string, format: string): string {
	const ext = FORMAT_EXTENSIONS[format as OutputFormat]?.ext ?? 'png';
	return `${appOrigin}/i/${shortId}/image.${ext}`;
}
