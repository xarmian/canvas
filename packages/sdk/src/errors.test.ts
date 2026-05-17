/**
 * Unit tests for the typed error classes + `throwFromResponse` mapping.
 *
 * Every fixture is a synthetic `Response` constructed locally so the
 * tests run without any network plumbing and stay deterministic.
 */
import { describe, expect, it } from 'vitest';
import {
	CanvasError,
	CanvasNotFoundError,
	InvalidParamError,
	QuotaExceededError,
	RateLimitError
} from './errors.js';
import { parseRateLimitHeaders, throwFromResponse } from './from-response.js';

function jsonResponse(
	status: number,
	body: unknown,
	extraHeaders: Record<string, string> = {}
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders }
	});
}

describe('CanvasError class hierarchy', () => {
	it('all typed errors are instances of CanvasError', () => {
		const rl = new RateLimitError('x', {
			retryAfterSeconds: 5,
			rateLimit: { limit: null, remaining: null, resetSeconds: null }
		});
		const qx = new QuotaExceededError('x', { status: 429, limit: 100, current: 100 });
		const nf = new CanvasNotFoundError('x');
		const ip = new InvalidParamError('x', { code: 'invalid_param', field: 'title' });

		expect(rl).toBeInstanceOf(CanvasError);
		expect(qx).toBeInstanceOf(CanvasError);
		expect(nf).toBeInstanceOf(CanvasError);
		expect(ip).toBeInstanceOf(CanvasError);

		// And every CanvasError is an Error.
		expect(rl).toBeInstanceOf(Error);
		expect(qx).toBeInstanceOf(Error);
		expect(nf).toBeInstanceOf(Error);
		expect(ip).toBeInstanceOf(Error);
	});

	it('each subclass has its own .name', () => {
		expect(new CanvasError('x').name).toBe('CanvasError');
		expect(
			new RateLimitError('x', {
				retryAfterSeconds: 0,
				rateLimit: { limit: null, remaining: null, resetSeconds: null }
			}).name
		).toBe('RateLimitError');
		expect(
			new QuotaExceededError('x', { status: 429, limit: null, current: null }).name
		).toBe('QuotaExceededError');
		expect(new CanvasNotFoundError('x').name).toBe('CanvasNotFoundError');
		expect(
			new InvalidParamError('x', { code: 'invalid_param', field: null }).name
		).toBe('InvalidParamError');
	});

	it('subclasses are NOT cross-instances of each other', () => {
		const rl = new RateLimitError('x', {
			retryAfterSeconds: 0,
			rateLimit: { limit: null, remaining: null, resetSeconds: null }
		});
		expect(rl).not.toBeInstanceOf(QuotaExceededError);
		expect(rl).not.toBeInstanceOf(CanvasNotFoundError);
		expect(rl).not.toBeInstanceOf(InvalidParamError);
	});
});

describe('parseRateLimitHeaders', () => {
	it('returns all-null when no headers are present', () => {
		expect(parseRateLimitHeaders(new Headers())).toEqual({
			limit: null,
			remaining: null,
			resetSeconds: null
		});
	});

	it('parses every triplet present', () => {
		const headers = new Headers({
			'X-RateLimit-Limit': '60',
			'X-RateLimit-Remaining': '17',
			'X-RateLimit-Reset': '42'
		});
		expect(parseRateLimitHeaders(headers)).toEqual({
			limit: 60,
			remaining: 17,
			resetSeconds: 42
		});
	});

	it('treats unparseable values as null', () => {
		const headers = new Headers({ 'X-RateLimit-Limit': 'forever' });
		expect(parseRateLimitHeaders(headers).limit).toBe(null);
	});
});

describe('throwFromResponse — RateLimitError', () => {
	it('maps body code "rate_limited" to RateLimitError with retryAfterSeconds from body', async () => {
		const res = jsonResponse(
			429,
			{ error: 'rate_limited', retryAfterSeconds: 12 },
			{
				'Retry-After': '12',
				'X-RateLimit-Limit': '60',
				'X-RateLimit-Remaining': '0'
			}
		);
		await expect(throwFromResponse(res)).rejects.toBeInstanceOf(RateLimitError);

		// Re-fetch to inspect the thrown error fields.
		const res2 = jsonResponse(
			429,
			{ error: 'rate_limited', retryAfterSeconds: 12 },
			{ 'Retry-After': '12', 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0' }
		);
		try {
			await throwFromResponse(res2);
		} catch (err) {
			const rl = err as RateLimitError;
			expect(rl.retryAfterSeconds).toBe(12);
			expect(rl.rateLimit.limit).toBe(60);
			expect(rl.rateLimit.remaining).toBe(0);
			expect(rl.status).toBe(429);
			expect(rl.code).toBe('rate_limited');
		}
	});

	it('falls back to Retry-After header when body lacks retryAfterSeconds', async () => {
		const res = jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '7' });
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(RateLimitError);
			expect((err as RateLimitError).retryAfterSeconds).toBe(7);
		}
	});

	it('429 with no body code still produces RateLimitError', async () => {
		const res = new Response('', { status: 429, headers: { 'Retry-After': '5' } });
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(RateLimitError);
			expect((err as RateLimitError).retryAfterSeconds).toBe(5);
		}
	});
});

describe('throwFromResponse — QuotaExceededError', () => {
	it('maps body code "quota_exceeded" (server sends at HTTP 429)', async () => {
		const res = jsonResponse(429, { error: 'quota_exceeded', limit: 100, current: 100 });
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(QuotaExceededError);
			expect(err).not.toBeInstanceOf(RateLimitError); // critical disambiguation
			const qx = err as QuotaExceededError;
			expect(qx.limit).toBe(100);
			expect(qx.current).toBe(100);
			expect(qx.status).toBe(429);
			expect(qx.code).toBe('quota_exceeded');
		}
	});

	it('tolerates missing limit/current numerics', async () => {
		const res = jsonResponse(429, { error: 'quota_exceeded' });
		try {
			await throwFromResponse(res);
		} catch (err) {
			const qx = err as QuotaExceededError;
			expect(qx.limit).toBe(null);
			expect(qx.current).toBe(null);
		}
	});
});

describe('throwFromResponse — CanvasNotFoundError', () => {
	it('maps body code "canvas_not_found" at 404', async () => {
		const res = jsonResponse(404, { error: 'canvas_not_found' });
		await expect(throwFromResponse(res)).rejects.toBeInstanceOf(CanvasNotFoundError);
	});

	it('maps bare 404 (no body code) to CanvasNotFoundError', async () => {
		const res = new Response('Not Found', { status: 404 });
		await expect(throwFromResponse(res)).rejects.toBeInstanceOf(CanvasNotFoundError);
	});
});

describe('throwFromResponse — InvalidParamError', () => {
	it('maps body code "invalid_param" and surfaces field + message', async () => {
		const res = jsonResponse(400, {
			error: 'invalid_param',
			field: 'title',
			message: 'title is required'
		});
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidParamError);
			const ip = err as InvalidParamError;
			expect(ip.field).toBe('title');
			expect(ip.message).toBe('title is required');
			expect(ip.code).toBe('invalid_param');
		}
	});

	it('maps "invalid_forward_url" with null field', async () => {
		const res = jsonResponse(400, {
			error: 'invalid_forward_url',
			message: 'forwardUrl must resolve to http or https'
		});
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidParamError);
			const ip = err as InvalidParamError;
			expect(ip.code).toBe('invalid_forward_url');
			expect(ip.field).toBe(null);
		}
	});

	it('maps "invalid_dpr" with null field', async () => {
		const res = jsonResponse(400, { error: 'invalid_dpr', message: 'dpr must be 1, 2, or 3' });
		try {
			await throwFromResponse(res);
		} catch (err) {
			const ip = err as InvalidParamError;
			expect(ip.code).toBe('invalid_dpr');
			expect(ip.field).toBe(null);
		}
	});

	it('maps a bare 400 (no body code) to InvalidParamError', async () => {
		const res = new Response('Bad Request', { status: 400 });
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidParamError);
			expect((err as InvalidParamError).code).toBe('invalid_request');
			expect((err as InvalidParamError).field).toBe(null);
		}
	});
});

describe('throwFromResponse — base CanvasError fallback', () => {
	it('maps an unknown 5xx to CanvasError', async () => {
		const res = new Response('Internal Server Error', { status: 500 });
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasError);
			expect(err).not.toBeInstanceOf(RateLimitError);
			expect(err).not.toBeInstanceOf(QuotaExceededError);
			expect(err).not.toBeInstanceOf(CanvasNotFoundError);
			expect(err).not.toBeInstanceOf(InvalidParamError);
			expect((err as CanvasError).status).toBe(500);
		}
	});

	it('maps a 401 with no body code to base CanvasError', async () => {
		const res = jsonResponse(401, { error: 'unauthorized' });
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasError);
			expect((err as CanvasError).status).toBe(401);
			expect((err as CanvasError).code).toBe('unauthorized');
		}
	});

	it('survives an empty body', async () => {
		const res = new Response('', { status: 502 });
		await expect(throwFromResponse(res)).rejects.toBeInstanceOf(CanvasError);
	});

	it('survives an invalid-JSON body (keeps it as a string)', async () => {
		const res = new Response('not json at all', {
			status: 502,
			headers: { 'Content-Type': 'text/plain' }
		});
		try {
			await throwFromResponse(res);
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasError);
			expect((err as CanvasError).body).toBe('not json at all');
		}
	});
});
