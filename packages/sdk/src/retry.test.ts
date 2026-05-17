/**
 * Tests for TASK-223:
 *
 * - `client.lastRateLimit` updates after every response (success
 *   AND failure).
 * - 429 with body `error: "rate_limited"` triggers a single
 *   `Retry-After`-honoring retry by default.
 * - 429 with body `error: "quota_exceeded"` is NEVER retried.
 * - `retryOn429: false` short-circuits the retry path.
 * - `maxRetries: 0` disables retries.
 * - Retry-After timing is honored (uses fake timers).
 * - AbortSignal cancels the retry wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CanvasClient,
	type BakedRender,
	type RenderList,
	QuotaExceededError,
	RateLimitError
} from './index.js';
import { parseRetryAfter } from './from-response.js';

const BASE_URL = 'https://canvas.example.com';
const API_KEY = 'sk_test_abc123';

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

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
	return new Response(null, { status, headers });
}

const SAMPLE_BAKED: BakedRender = {
	id: 'abc123',
	url: `${BASE_URL}/i/abc123`,
	imageUrl: `${BASE_URL}/i/abc123/image.png`,
	forwardUrl: null,
	deduplicated: false,
	createdAt: '2026-05-17T00:00:00.000Z'
};

const EMPTY_LIST: RenderList = { items: [], nextCursor: null };

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('client.lastRateLimit', () => {
	it('is null before any request', () => {
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		expect(client.lastRateLimit).toBe(null);
	});

	it('updates after a successful response', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(201, SAMPLE_BAKED, {
				'X-RateLimit-Limit': '60',
				'X-RateLimit-Remaining': '42',
				'X-RateLimit-Reset': '17'
			})
		);
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		await client.bake('og-card');
		expect(client.lastRateLimit).toEqual({ limit: 60, remaining: 42, resetSeconds: 17 });
	});

	it('updates after a non-2xx response (before the error is thrown)', async () => {
		// Mock returns a 404 with headers; lastRateLimit should be set
		// even though the call rejected.
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(
				404,
				{ error: 'canvas_not_found' },
				{ 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '59' }
			)
		);
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		await expect(client.bake('og-card')).rejects.toThrow();
		expect(client.lastRateLimit).toEqual({ limit: 60, remaining: 59, resetSeconds: null });
	});

	it('updates after a list() success too (any roundtrip method)', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, EMPTY_LIST, {
				'X-RateLimit-Limit': '100',
				'X-RateLimit-Remaining': '99',
				'X-RateLimit-Reset': '60'
			})
		);
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		await client.list();
		expect(client.lastRateLimit).toEqual({ limit: 100, remaining: 99, resetSeconds: 60 });
	});

	it('triplet fields default to null when the corresponding header is missing', async () => {
		// HTTP 204 forbids a body — use 200 + empty list for this fixture.
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, EMPTY_LIST, { 'X-RateLimit-Limit': '60' })
		);
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		await client.list();
		expect(client.lastRateLimit).toEqual({ limit: 60, remaining: null, resetSeconds: null });
	});
});

describe('retry on 429 rate_limited', () => {
	it('retries once with Retry-After delay, then returns the success', async () => {
		vi.useFakeTimers();
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '5' })
			)
			.mockResolvedValueOnce(jsonResponse(201, SAMPLE_BAKED));

		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		const promise = client.bake('og-card');

		// Let the first fetch + clone + body parse settle.
		await vi.runOnlyPendingTimersAsync();
		// Advance through the 5-second Retry-After wait.
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await promise;

		expect(result).toEqual(SAMPLE_BAKED);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('throws RateLimitError when retry also returns 429', async () => {
		vi.useFakeTimers();
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue(
			jsonResponse(
				429,
				{ error: 'rate_limited', retryAfterSeconds: 3 },
				{ 'Retry-After': '3' }
			)
		);

		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		const promise = client.bake('og-card');
		// Swallow rejection up front so vitest's unhandled-rejection guard
		// doesn't fire while we drive fake timers forward.
		const rejection = expect(promise).rejects.toBeInstanceOf(RateLimitError);

		await vi.advanceTimersByTimeAsync(3_000);
		await rejection;
		// Two attempts: initial + one retry. With maxRetries=1, that's the cap.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('defaults Retry-After to 1s when the header is missing or unparseable', async () => {
		vi.useFakeTimers();
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock
			.mockResolvedValueOnce(jsonResponse(429, { error: 'rate_limited' })) // no Retry-After
			.mockResolvedValueOnce(jsonResponse(201, SAMPLE_BAKED));

		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		const promise = client.bake('og-card');

		// Advancing by 999ms shouldn't fire the retry yet.
		await vi.advanceTimersByTimeAsync(999);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// One more ms = 1s elapsed; retry fires.
		await vi.advanceTimersByTimeAsync(1);
		const result = await promise;
		expect(result).toEqual(SAMPLE_BAKED);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('no retry on quota_exceeded (must not double-count)', () => {
	it('throws QuotaExceededError on first 429 quota_exceeded, no retry attempted', async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue(
			jsonResponse(429, { error: 'quota_exceeded', limit: 100, current: 100 })
		);

		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		await expect(client.bake('og-card')).rejects.toBeInstanceOf(QuotaExceededError);
		// Critical: exactly ONE call — the retry path must not fire.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('quota_exceeded is not caught as RateLimitError after retry policy', async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue(
			jsonResponse(429, { error: 'quota_exceeded', limit: 100, current: 100 })
		);
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		try {
			await client.bake('og-card');
		} catch (err) {
			expect(err).toBeInstanceOf(QuotaExceededError);
			expect(err).not.toBeInstanceOf(RateLimitError);
		}
	});
});

describe('retry configuration', () => {
	it('retryOn429: false short-circuits to RateLimitError on first 429', async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue(
			jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '99' })
		);
		const client = new CanvasClient({
			baseUrl: BASE_URL,
			apiKey: API_KEY,
			retryOn429: false
		});
		await expect(client.bake('og-card')).rejects.toBeInstanceOf(RateLimitError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maxRetries: 0 disables retries (also short-circuits on first 429)', async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue(
			jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '99' })
		);
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY, maxRetries: 0 });
		await expect(client.bake('og-card')).rejects.toBeInstanceOf(RateLimitError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('maxRetries: 2 allows up to three total attempts', async () => {
		// Use real timers and Retry-After=0 (which our code clamps to 0ms
		// sleep, effectively a microtask hop). Fake timers compose poorly
		// with `setTimeout(..., 0)` chained across multiple awaits because
		// each iteration's promise resolution is queued behind the prior
		// timer tick — easier to just let the event loop run.
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '0' })
			)
			.mockResolvedValueOnce(
				jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '0' })
			)
			.mockResolvedValueOnce(jsonResponse(201, SAMPLE_BAKED));

		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY, maxRetries: 2 });
		const result = await client.bake('og-card');
		expect(result).toEqual(SAMPLE_BAKED);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('rejects a non-integer or negative maxRetries in the constructor', () => {
		expect(
			() => new CanvasClient({ baseUrl: BASE_URL, maxRetries: -1 })
		).toThrow(TypeError);
		expect(
			() => new CanvasClient({ baseUrl: BASE_URL, maxRetries: 1.5 })
		).toThrow(TypeError);
	});

	it('exposes retryOn429 and maxRetries on the instance', () => {
		const client = new CanvasClient({
			baseUrl: BASE_URL,
			apiKey: API_KEY,
			retryOn429: false,
			maxRetries: 3
		});
		expect(client.retryOn429).toBe(false);
		expect(client.maxRetries).toBe(3);
	});

	it('defaults retryOn429=true and maxRetries=1', () => {
		const client = new CanvasClient({ baseUrl: BASE_URL });
		expect(client.retryOn429).toBe(true);
		expect(client.maxRetries).toBe(1);
	});
});

describe('parseRetryAfter — RFC 9110 forms (Codex round 1 P2)', () => {
	it('parses delta-seconds form', () => {
		expect(parseRetryAfter('5')).toBe(5000);
		expect(parseRetryAfter('0')).toBe(0);
		expect(parseRetryAfter('120')).toBe(120_000);
	});

	it('parses HTTP-date form (RFC 1123)', () => {
		const now = Date.parse('2026-05-17T12:00:00Z');
		// 30 seconds in the future, RFC 1123 format.
		const future = new Date(now + 30_000).toUTCString();
		expect(parseRetryAfter(future, now)).toBe(30_000);
	});

	it('returns 1s default when the HTTP-date is in the past', () => {
		const now = Date.parse('2026-05-17T12:00:00Z');
		const past = new Date(now - 60_000).toUTCString();
		expect(parseRetryAfter(past, now)).toBe(1000);
	});

	it('returns 1s default for null / empty / garbage', () => {
		expect(parseRetryAfter(null)).toBe(1000);
		expect(parseRetryAfter('')).toBe(1000);
		expect(parseRetryAfter('   ')).toBe(1000);
		expect(parseRetryAfter('not a header value')).toBe(1000);
	});

	it('rejects negative delta-seconds (regex-only match)', () => {
		expect(parseRetryAfter('-5')).toBe(1000);
	});
});

describe('RateLimitError.retryAfterSeconds parses HTTP-date too (Codex round 2)', () => {
	it('disabled-retry path surfaces correct retryAfterSeconds from HTTP-date Retry-After', async () => {
		// Codex round 2: without parseRetryAfter in from-response.ts,
		// a manual `catch` on a date-form Retry-After 429 would see
		// retryAfterSeconds: 0 even though the retry path would honor
		// the value correctly. Lock the parity in.
		const now = Date.now();
		const httpDate = new Date(now + 45_000).toUTCString();
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response('', { status: 429, headers: { 'Retry-After': httpDate } })
		);
		const client = new CanvasClient({
			baseUrl: BASE_URL,
			apiKey: API_KEY,
			retryOn429: false
		});
		try {
			await client.bake('og-card');
		} catch (err) {
			expect(err).toBeInstanceOf(RateLimitError);
			const rl = err as RateLimitError;
			// 45 seconds ahead — allow ±1s slack for the time tick
			// between now-capture and the call.
			expect(rl.retryAfterSeconds).toBeGreaterThanOrEqual(44);
			expect(rl.retryAfterSeconds).toBeLessThanOrEqual(46);
		}
	});

	it('body retryAfterSeconds wins over header when present', async () => {
		// Server-emitted Canvas API responses include both — the
		// explicit numeric field is more authoritative.
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 7 }), {
				status: 429,
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': new Date(Date.now() + 60_000).toUTCString()
				}
			})
		);
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY, retryOn429: false });
		try {
			await client.bake('og-card');
		} catch (err) {
			expect((err as RateLimitError).retryAfterSeconds).toBe(7);
		}
	});
});

describe('retry honors RFC 9110 HTTP-date Retry-After', () => {
	it('waits until the date specified in Retry-After header', async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		// 0ms-in-the-future date so we don't have to wait in tests.
		const httpDate = new Date(Date.now()).toUTCString();
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': httpDate })
			)
			.mockResolvedValueOnce(jsonResponse(201, SAMPLE_BAKED));

		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		const result = await client.bake('og-card');
		expect(result).toEqual(SAMPLE_BAKED);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('AbortSignal during retry wait', () => {
	it('cancelling mid-wait throws CanvasError before the retry fires', async () => {
		vi.useFakeTimers();
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValueOnce(
			jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '60' })
		);

		const controller = new AbortController();
		const client = new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
		const promise = client.bake('og-card', {}, { signal: controller.signal });

		// Let the first fetch resolve and the sleep start.
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();

		await expect(promise).rejects.toThrow(/aborted/i);
		// fetch was called once (initial); the retry never fired.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
