/**
 * Tests for `client.list()`, `client.get()`, `client.delete()`.
 *
 * Mirrors the `bake.test.ts` plumbing — `vi.stubGlobal('fetch', ...)`
 * for full control over the round-trip without any network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CanvasClient,
	CanvasNotFoundError,
	InvalidParamError,
	type RenderDetail
} from './index.js';

const BASE_URL = 'https://canvas.example.com';
const API_KEY = 'sk_test_abc123';

function makeClient(): CanvasClient {
	return new CanvasClient({ baseUrl: BASE_URL, apiKey: API_KEY });
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

function lastFetchCall(): { url: string; init: RequestInit } {
	const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
	const [url, init] = calls[calls.length - 1] as [string, RequestInit];
	return { url, init };
}

const SAMPLE_DETAIL: RenderDetail = {
	id: 'abc123xyz0',
	url: `${BASE_URL}/i/abc123xyz0`,
	imageUrl: `${BASE_URL}/i/abc123xyz0/image.png`,
	canvasId: '00000000-0000-0000-0000-000000000001',
	canvasSlug: 'og-card',
	canvasName: 'OG Card',
	format: 'png',
	sizeBytes: 12345,
	width: 1200,
	height: 630,
	forwardUrl: null,
	ogTitle: 'Hello',
	ogDescription: null,
	createdAt: '2026-05-17T00:00:00.000Z',
	lastAccessedAt: '2026-05-17T01:00:00.000Z',
	expiresAt: null
};

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('list() — happy path', () => {
	it('returns the page with items + nextCursor', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, { items: [SAMPLE_DETAIL], nextCursor: 'cursor-base64url' })
		);
		const page = await makeClient().list();
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toEqual(SAMPLE_DETAIL);
		expect(page.nextCursor).toBe('cursor-base64url');
	});

	it('returns an empty page', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, { items: [], nextCursor: null })
		);
		const page = await makeClient().list();
		expect(page.items).toEqual([]);
		expect(page.nextCursor).toBe(null);
	});
});

describe('list() — request shape', () => {
	beforeEach(() => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, { items: [], nextCursor: null })
		);
	});

	it('GETs /api/v1/renders with no query when no opts', async () => {
		await makeClient().list();
		const { url, init } = lastFetchCall();
		expect(url).toBe(`${BASE_URL}/api/v1/renders`);
		expect(init.method).toBe('GET');
	});

	it('omits the body on GET', async () => {
		await makeClient().list();
		const { init } = lastFetchCall();
		expect(init.body).toBeUndefined();
	});

	it('does not set Content-Type when there is no body', async () => {
		// `unknown_field` rejection isn't a concern here, but `Content-Type:
		// application/json` on a body-less GET is non-idiomatic and would
		// stand out in a request log. Verify the request wrapper omits it.
		await makeClient().list();
		const { init } = lastFetchCall();
		const headers = new Headers(init.headers);
		expect(headers.has('Content-Type')).toBe(false);
	});

	it('sets Authorization: Bearer <apiKey>', async () => {
		await makeClient().list();
		const headers = new Headers(lastFetchCall().init.headers);
		expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
	});

	it('appends canvas filter', async () => {
		await makeClient().list({ canvas: 'og-card' });
		expect(lastFetchCall().url).toBe(`${BASE_URL}/api/v1/renders?canvas=og-card`);
	});

	it('appends limit (coerced to string)', async () => {
		await makeClient().list({ limit: 50 });
		expect(lastFetchCall().url).toBe(`${BASE_URL}/api/v1/renders?limit=50`);
	});

	it('appends cursor', async () => {
		await makeClient().list({ cursor: 'eyJjcmVhdGVkQXQiOiJ4In0' });
		expect(lastFetchCall().url).toBe(
			`${BASE_URL}/api/v1/renders?cursor=eyJjcmVhdGVkQXQiOiJ4In0`
		);
	});

	it('appends every query param when set', async () => {
		await makeClient().list({ canvas: 'og-card', limit: 25, cursor: 'opaque' });
		const url = new URL(lastFetchCall().url);
		expect(url.searchParams.get('canvas')).toBe('og-card');
		expect(url.searchParams.get('limit')).toBe('25');
		expect(url.searchParams.get('cursor')).toBe('opaque');
	});

	it('drops undefined query params (no canvas=undefined in URL)', async () => {
		await makeClient().list({ canvas: undefined, limit: 10 });
		const url = new URL(lastFetchCall().url);
		expect(url.searchParams.has('canvas')).toBe(false);
		expect(url.searchParams.get('limit')).toBe('10');
	});

	it('passes through AbortSignal', async () => {
		const controller = new AbortController();
		await makeClient().list({ signal: controller.signal });
		expect(lastFetchCall().init.signal).toBe(controller.signal);
	});
});

describe('list() — error mapping', () => {
	it('400 invalid_cursor → InvalidParamError', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(400, { error: 'invalid_cursor', message: 'cursor could not be decoded' })
		);
		try {
			await makeClient().list({ cursor: 'garbage' });
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidParamError);
			expect((err as InvalidParamError).code).toBe('invalid_cursor');
		}
	});

	it('400 invalid_limit → InvalidParamError', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(400, { error: 'invalid_limit', message: 'limit must be a positive integer' })
		);
		try {
			await makeClient().list({ limit: -1 });
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidParamError);
			expect((err as InvalidParamError).code).toBe('invalid_limit');
		}
	});
});

describe('get() — happy path', () => {
	it('returns the full RenderDetail', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, SAMPLE_DETAIL)
		);
		const detail = await makeClient().get('abc123xyz0');
		expect(detail).toEqual(SAMPLE_DETAIL);
	});

	it('GETs /api/v1/renders/{shortId}', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, SAMPLE_DETAIL)
		);
		await makeClient().get('abc123xyz0');
		const { url, init } = lastFetchCall();
		expect(url).toBe(`${BASE_URL}/api/v1/renders/abc123xyz0`);
		expect(init.method).toBe('GET');
	});

	it('trims whitespace from shortId', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, SAMPLE_DETAIL)
		);
		await makeClient().get('  abc123xyz0  ');
		expect(lastFetchCall().url).toBe(`${BASE_URL}/api/v1/renders/abc123xyz0`);
	});

	it('passes through AbortSignal', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(200, SAMPLE_DETAIL)
		);
		const controller = new AbortController();
		await makeClient().get('abc123xyz0', { signal: controller.signal });
		expect(lastFetchCall().init.signal).toBe(controller.signal);
	});
});

describe('get() — argument validation', () => {
	it.each([
		['empty', ''],
		['whitespace', '   '],
		['slash', 'abc/xyz'],
		['backslash', 'abc\\xyz'],
		['question mark', 'abc?xyz'],
		['hash', 'abc#xyz']
	])('throws TypeError for path-unsafe shortId: %s', async (_label, shortId) => {
		await expect(makeClient().get(shortId)).rejects.toThrow(TypeError);
	});

	it('does NOT fetch when shortId is invalid', async () => {
		await expect(makeClient().get('')).rejects.toThrow(TypeError);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('get() — error mapping', () => {
	it('404 → CanvasNotFoundError', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(404, { message: 'render_not_found' })
		);
		await expect(makeClient().get('abc123xyz0')).rejects.toBeInstanceOf(CanvasNotFoundError);
	});
});

describe('delete() — happy path', () => {
	it('resolves to undefined on 204', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(null, { status: 204 })
		);
		await expect(makeClient().delete('abc123xyz0')).resolves.toBeUndefined();
	});

	it('DELETEs /api/v1/renders/{shortId}', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(null, { status: 204 })
		);
		await makeClient().delete('abc123xyz0');
		const { url, init } = lastFetchCall();
		expect(url).toBe(`${BASE_URL}/api/v1/renders/abc123xyz0`);
		expect(init.method).toBe('DELETE');
	});

	it('does NOT send a body on DELETE', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(null, { status: 204 })
		);
		await makeClient().delete('abc123xyz0');
		expect(lastFetchCall().init.body).toBeUndefined();
	});

	it('sets Authorization: Bearer <apiKey>', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(null, { status: 204 })
		);
		await makeClient().delete('abc123xyz0');
		const headers = new Headers(lastFetchCall().init.headers);
		expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`);
	});

	it('passes through AbortSignal', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			new Response(null, { status: 204 })
		);
		const controller = new AbortController();
		await makeClient().delete('abc123xyz0', { signal: controller.signal });
		expect(lastFetchCall().init.signal).toBe(controller.signal);
	});
});

describe('delete() — argument validation', () => {
	it.each([
		['empty', ''],
		['slash', 'abc/xyz'],
		['hash', 'abc#xyz']
	])('throws TypeError for path-unsafe shortId: %s', async (_label, shortId) => {
		await expect(makeClient().delete(shortId)).rejects.toThrow(TypeError);
	});

	it('does NOT fetch when shortId is invalid', async () => {
		await expect(makeClient().delete('   ')).rejects.toThrow(TypeError);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('delete() — error mapping', () => {
	it('404 (idempotency loss) → CanvasNotFoundError', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse(404, { message: 'render_not_found' })
		);
		await expect(makeClient().delete('abc123xyz0')).rejects.toBeInstanceOf(CanvasNotFoundError);
	});
});
