/**
 * Tests for `client.bake()` and the shared `request<T>()` fetch wrapper.
 *
 * Strategy: stub `globalThis.fetch` with `vi.fn()` so each test can
 * assert the outgoing request (URL, headers, body) and inject the
 * response (status, body, headers) without any network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CanvasClient,
	type BakedRender,
	CanvasError,
	CanvasNotFoundError,
	InvalidParamError,
	QuotaExceededError,
	RateLimitError
} from './index.js';

const BASE_URL = 'https://canvas.example.com';
const API_KEY = 'sk_test_abc123';

function makeClient(overrides: Partial<{ apiKey: string }> = {}): CanvasClient {
	return new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY, ...overrides });
}

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

/** Read the last call to the fetch mock as a typed tuple. */
function lastFetchCall(): { url: string; init: RequestInit } {
	const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
	const [url, init] = calls[calls.length - 1] as [string, RequestInit];
	return { url, init };
}

const SAMPLE_BAKED: BakedRender = {
	id: 'abc123',
	url: `${BASE_URL}/i/abc123`,
	imageUrl: `${BASE_URL}/i/abc123/image.png`,
	forwardUrl: null,
	deduplicated: false,
	createdAt: '2026-05-17T00:00:00.000Z'
};

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('bake() — happy path', () => {
	it('returns the BakedRender on 201 (new render)', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(201, SAMPLE_BAKED)
		);
		const client = makeClient();
		const result = await client.bake('og-card', { title: 'Hello' });
		expect(result).toEqual(SAMPLE_BAKED);
	});

	it('returns the BakedRender on 200 (dedup hit)', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, { ...SAMPLE_BAKED, deduplicated: true })
		);
		const client = makeClient();
		const result = await client.bake('og-card', { title: 'Hello' });
		expect(result.deduplicated).toBe(true);
	});
});

describe('bake() — request shape', () => {
	beforeEach(() => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(201, SAMPLE_BAKED)
		);
	});

	it('POSTs to /api/v1/renders under the configured baseUrl', async () => {
		const client = makeClient();
		await client.bake('og-card', { title: 'Hello' });
		const { url, init } = lastFetchCall();
		expect(url).toBe(`${BASE_URL}/api/v1/renders`);
		expect(init.method).toBe('POST');
	});

	it('sets Authorization: Bearer <apiKey>', async () => {
		const client = makeClient();
		await client.bake('og-card');
		const { init } = lastFetchCall();
		const headers = new Headers(init.headers);
		expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
	});

	it('sets Content-Type application/json and Accept application/json', async () => {
		const client = makeClient();
		await client.bake('og-card');
		const { init } = lastFetchCall();
		const headers = new Headers(init.headers);
		expect(headers.get('Content-Type')).toBe('application/json');
		expect(headers.get('Accept')).toBe('application/json');
	});

	it('serializes canvas + params as JSON body', async () => {
		const client = makeClient();
		await client.bake('og-card', { title: 'Hello', subtitle: 'World' });
		const { init } = lastFetchCall();
		const body = JSON.parse(init.body as string);
		expect(body).toEqual({
			canvas: 'og-card',
			params: { title: 'Hello', subtitle: 'World' }
		});
	});

	it('coerces non-string param values to strings (server requires string values)', async () => {
		const client = makeClient();
		await client.bake('og-card', { count: 42, active: true, label: '' });
		const { init } = lastFetchCall();
		const body = JSON.parse(init.body as string);
		expect(body.params).toEqual({ count: '42', active: 'true', label: '' });
	});

	it('drops null/undefined param values', async () => {
		const client = makeClient();
		await client.bake('og-card', { title: 'Keep', missing: undefined, absent: null });
		const { init } = lastFetchCall();
		const body = JSON.parse(init.body as string);
		expect(body.params).toEqual({ title: 'Keep' });
	});

	it('omits opts that were not set (no unknown_field rejection)', async () => {
		const client = makeClient();
		await client.bake('og-card', { title: 'Hi' });
		const { init } = lastFetchCall();
		const body = JSON.parse(init.body as string);
		// Only canvas + params keys — no format/forwardUrl/etc.
		expect(Object.keys(body).sort()).toEqual(['canvas', 'params']);
	});

	it('forwards every BakeOption when set', async () => {
		const client = makeClient();
		await client.bake(
			'og-card',
			{ title: 'Hi' },
			{
				format: 'webp',
				forwardUrl: 'https://example.com/promo',
				ogTitle: 'Title',
				ogDescription: 'Description',
				dpr: 2
			}
		);
		const { init } = lastFetchCall();
		const body = JSON.parse(init.body as string);
		expect(body).toEqual({
			canvas: 'og-card',
			params: { title: 'Hi' },
			format: 'webp',
			forwardUrl: 'https://example.com/promo',
			ogTitle: 'Title',
			ogDescription: 'Description',
			dpr: 2
		});
	});

	it('forwards `forwardUrl: null` and `ogTitle: null` explicitly when set', async () => {
		// `null` is meaningful — the server treats it as "no forward URL"
		// distinct from "field not provided." Make sure we don't drop it
		// to `undefined`.
		const client = makeClient();
		await client.bake('og-card', {}, { forwardUrl: null, ogTitle: null });
		const { init } = lastFetchCall();
		const body = JSON.parse(init.body as string);
		expect(body.forwardUrl).toBe(null);
		expect(body.ogTitle).toBe(null);
	});

	it('trims whitespace from the slug', async () => {
		const client = makeClient();
		await client.bake('  og-card  ');
		const { init } = lastFetchCall();
		const body = JSON.parse(init.body as string);
		expect(body.canvas).toBe('og-card');
	});

	it('passes through AbortSignal', async () => {
		const client = makeClient();
		const controller = new AbortController();
		await client.bake('og-card', {}, { signal: controller.signal });
		const { init } = lastFetchCall();
		expect(init.signal).toBe(controller.signal);
	});
});

describe('bake() — argument validation', () => {
	it('throws TypeError when slug is empty', async () => {
		const client = makeClient();
		await expect(client.bake('')).rejects.toThrow(TypeError);
	});

	it('throws TypeError when slug is whitespace-only', async () => {
		const client = makeClient();
		await expect(client.bake('   ')).rejects.toThrow(TypeError);
	});

	it('throws TypeError when slug is not a string', async () => {
		const client = makeClient();
		// @ts-expect-error — exercising the runtime guard
		await expect(client.bake(123)).rejects.toThrow(TypeError);
	});

	it('throws TypeError when client has no apiKey', async () => {
		const client = new CanvasClient({ baseUrl: BASE_URL });
		await expect(client.bake('og-card')).rejects.toThrow(TypeError);
		// fetch was never invoked.
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('bake() — error mapping', () => {
	it('400 invalid_params with field → InvalidParamError', async () => {
		// `mockImplementation` returns a fresh Response on every call —
		// Response bodies are single-use, so reusing `mockResolvedValue`
		// would make the second-call assertion see an already-consumed
		// body and lose the `field`.
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
			Promise.resolve(
				jsonResponse(400, {
					error: 'invalid_params',
					field: 'title',
					message: 'must be a string'
				})
			)
		);
		const client = makeClient();
		try {
			await client.bake('og-card');
			throw new Error('expected bake() to reject');
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidParamError);
			const ip = err as InvalidParamError;
			expect(ip.field).toBe('title');
			expect(ip.code).toBe('invalid_params');
			expect(ip.message).toBe('must be a string');
		}
	});

	it('404 canvas_not_found → CanvasNotFoundError', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(404, { error: 'canvas_not_found' })
		);
		await expect(makeClient().bake('og-card')).rejects.toBeInstanceOf(CanvasNotFoundError);
	});

	it('429 rate_limited → RateLimitError', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(
				429,
				{ error: 'rate_limited', retryAfterSeconds: 12 },
				{ 'Retry-After': '12', 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0' }
			)
		);
		try {
			await makeClient().bake('og-card');
		} catch (err) {
			expect(err).toBeInstanceOf(RateLimitError);
			const rl = err as RateLimitError;
			expect(rl.retryAfterSeconds).toBe(12);
		}
	});

	it('429 quota_exceeded → QuotaExceededError (not RateLimitError)', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(429, { error: 'quota_exceeded', limit: 100, current: 100 })
		);
		try {
			await makeClient().bake('og-card');
		} catch (err) {
			expect(err).toBeInstanceOf(QuotaExceededError);
			expect(err).not.toBeInstanceOf(RateLimitError);
			expect((err as QuotaExceededError).limit).toBe(100);
		}
	});

	it('500 → base CanvasError', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response('Internal Server Error', { status: 500 })
		);
		try {
			await makeClient().bake('og-card');
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasError);
			expect(err).not.toBeInstanceOf(RateLimitError);
			expect(err).not.toBeInstanceOf(QuotaExceededError);
			expect(err).not.toBeInstanceOf(CanvasNotFoundError);
			expect(err).not.toBeInstanceOf(InvalidParamError);
			expect((err as CanvasError).status).toBe(500);
		}
	});

	it('network failure → CanvasError with cause', async () => {
		const networkErr = new TypeError('fetch failed');
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(networkErr);
		try {
			await makeClient().bake('og-card');
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasError);
			expect((err as CanvasError).message).toContain('fetch failed');
			expect((err as Error).cause).toBe(networkErr);
		}
	});

	it('AbortSignal cancellation surfaces as CanvasError', async () => {
		const abortErr = new DOMException('Aborted', 'AbortError');
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abortErr);
		const controller = new AbortController();
		controller.abort();
		try {
			await makeClient().bake('og-card', {}, { signal: controller.signal });
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasError);
			expect((err as Error).cause).toBe(abortErr);
		}
	});
});
