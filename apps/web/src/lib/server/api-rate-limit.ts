/**
 * Helpers for applying the per-API-key rate limit to `/api/v1/*`
 * handlers. The lower-level token-bucket lives in `render-throttle.ts`;
 * this module wraps it in the route-handler contract: throw a structured
 * 429 Response on exhaustion, return a "decorate headers" closure to
 * attach `X-RateLimit-*` to the eventual 2xx response.
 */
import { checkApiKeyRateLimit, type ApiKeyRateLimitKind } from './render-throttle';

/** Decorate an existing Response with the X-RateLimit-* headers. Returns
 *  a new Response so callers can keep streaming bodies intact. */
function withRateLimitHeaders(
	response: Response,
	headers: { limit: number; remaining: number; resetSec: number }
): Response {
	response.headers.set('X-RateLimit-Limit', String(headers.limit));
	response.headers.set('X-RateLimit-Remaining', String(headers.remaining));
	response.headers.set('X-RateLimit-Reset', String(headers.resetSec));
	return response;
}

/**
 * Gate a request through the per-API-key bucket. On exhaustion, throws a
 * `Response` (structured 429 with `Retry-After` and X-RateLimit headers).
 * On success, returns a decorator that the handler should use to attach
 * the limit headers to the eventual 2xx response:
 *
 *   const decorate = enforceApiKeyRateLimit(apiKey.id, 'write');
 *   const result = json({ ... });
 *   return decorate(result);
 */
export function enforceApiKeyRateLimit(
	apiKeyId: string,
	kind: ApiKeyRateLimitKind
): (response: Response) => Response {
	const result = checkApiKeyRateLimit(apiKeyId, kind);
	if (!result.allowed) {
		throw new Response(
			JSON.stringify({
				error: 'rate_limited',
				retryAfterSeconds: result.retryAfterSeconds
			}),
			{
				status: 429,
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': String(result.retryAfterSeconds),
					'X-RateLimit-Limit': String(result.limit),
					'X-RateLimit-Remaining': '0'
				}
			}
		);
	}
	const { limit, remaining, resetSec } = result;
	return (response) => withRateLimitHeaders(response, { limit, remaining, resetSec });
}
