/**
 * Unit tests for `CanvasClient` constructor + `client.image()` URL
 * builder.
 *
 * The "parity" tests here round-trip a built URL through the same
 * `URL` + `URLSearchParams` API the server route uses
 * (`apps/web/src/routes/c/[slug]/[file]/+server.ts:219`) so a passing
 * test guarantees the encoding the SDK produces is the encoding the
 * server consumes.
 */
import { describe, expect, it } from 'vitest';
import { CanvasClient } from './client.js';

describe('CanvasClient constructor', () => {
	it('accepts a valid baseUrl', () => {
		const client = new CanvasClient({ baseUrl: 'https://canvas.example.com' });
		expect(client.baseUrl).toBe('https://canvas.example.com');
	});

	it('strips a single trailing slash from baseUrl', () => {
		const client = new CanvasClient({ baseUrl: 'https://canvas.example.com/' });
		expect(client.baseUrl).toBe('https://canvas.example.com');
	});

	it('strips multiple trailing slashes from baseUrl', () => {
		const client = new CanvasClient({ baseUrl: 'https://canvas.example.com///' });
		expect(client.baseUrl).toBe('https://canvas.example.com');
	});

	it('preserves a path prefix on baseUrl', () => {
		const client = new CanvasClient({ baseUrl: 'https://example.com/canvas' });
		expect(client.baseUrl).toBe('https://example.com/canvas');
	});

	it('preserves apiKey when provided', () => {
		const client = new CanvasClient({
			baseUrl: 'https://canvas.example.com',
			apiKey: 'sk_test_abc'
		});
		expect(client.apiKey).toBe('sk_test_abc');
	});

	it('apiKey is undefined when not provided', () => {
		const client = new CanvasClient({ baseUrl: 'https://canvas.example.com' });
		expect(client.apiKey).toBeUndefined();
	});

	it.each([
		['empty string', ''],
		['whitespace only', '   '],
		['not a URL', 'canvas.example.com'],
		['unsupported protocol literal', 'not-a-url']
	])('rejects invalid baseUrl: %s', (_label, baseUrl) => {
		expect(() => new CanvasClient({ baseUrl })).toThrow(TypeError);
	});

	it('rejects a missing config', () => {
		// @ts-expect-error — exercising the runtime guard
		expect(() => new CanvasClient()).toThrow(TypeError);
	});

	it('rejects a non-string baseUrl', () => {
		// @ts-expect-error — exercising the runtime guard
		expect(() => new CanvasClient({ baseUrl: 123 })).toThrow(TypeError);
	});
});

describe('CanvasClient.image() — URL shape', () => {
	const client = new CanvasClient({ baseUrl: 'https://canvas.example.com' });

	it('builds /c/{slug}/image.png with no params', () => {
		expect(client.image('og-card')).toBe('https://canvas.example.com/c/og-card/image.png');
	});

	it('appends a single string param', () => {
		expect(client.image('og-card', { title: 'Hello' })).toBe(
			'https://canvas.example.com/c/og-card/image.png?title=Hello'
		);
	});

	it('appends multiple params in insertion order', () => {
		const url = client.image('og-card', { title: 'Hello', subtitle: 'World' });
		expect(url).toBe(
			'https://canvas.example.com/c/og-card/image.png?title=Hello&subtitle=World'
		);
	});

	it('preserves a baseUrl with a path prefix', () => {
		const c = new CanvasClient({ baseUrl: 'https://example.com/canvas' });
		expect(c.image('og-card', { title: 'Hi' })).toBe(
			'https://example.com/canvas/c/og-card/image.png?title=Hi'
		);
	});
});

describe('CanvasClient.image() — param coercion', () => {
	const client = new CanvasClient({ baseUrl: 'https://canvas.example.com' });

	it('coerces numbers to strings', () => {
		const url = client.image('card', { count: 42 });
		expect(new URL(url).searchParams.get('count')).toBe('42');
	});

	it('coerces booleans to "true" / "false"', () => {
		const url = client.image('card', { active: true, hidden: false });
		const search = new URL(url).searchParams;
		expect(search.get('active')).toBe('true');
		expect(search.get('hidden')).toBe('false');
	});

	it('drops null and undefined values', () => {
		const url = client.image('card', {
			title: 'Keep',
			missing: undefined,
			absent: null
		});
		const search = new URL(url).searchParams;
		expect(search.get('title')).toBe('Keep');
		expect(search.has('missing')).toBe(false);
		expect(search.has('absent')).toBe(false);
	});

	it('renders no `?` when every value is null/undefined', () => {
		expect(client.image('card', { a: undefined, b: null })).toBe(
			'https://canvas.example.com/c/card/image.png'
		);
	});

	it('coerces zero and empty string (NOT dropped)', () => {
		const url = client.image('card', { count: 0, label: '' });
		const search = new URL(url).searchParams;
		expect(search.get('count')).toBe('0');
		expect(search.get('label')).toBe('');
	});
});

describe('CanvasClient.image() — parity with server URL parser', () => {
	const client = new CanvasClient({ baseUrl: 'https://canvas.example.com' });

	/**
	 * The server route does:
	 *
	 *   for (const [key, value] of url.searchParams) {
	 *     // forward to renderer
	 *   }
	 *
	 * So the SDK's encoding parity is "does `new URL(builtUrl)
	 * .searchParams` produce the same entries we put in?" — which is
	 * exactly the round-trip these cases assert.
	 */
	it.each([
		['ASCII letters and digits', { title: 'Hello123' }],
		['spaces', { title: 'Hello World' }],
		['ampersand', { title: 'Marks & Spencer' }],
		['equals sign', { eq: 'a=b' }],
		['plus sign', { math: '1+1=2' }],
		['question mark', { q: 'where?' }],
		['hash', { tag: '#blessed' }],
		['slash', { path: 'a/b/c' }],
		['unicode', { greet: 'héllo 🎉' }],
		['mixed', { title: 'OG: Hello & Welcome', subtitle: 'with spaces, &, =, +' }]
	])('round-trips %s param values losslessly', (_label, params) => {
		const url = client.image('og-card', params);
		const parsed = new URL(url).searchParams;
		for (const [key, value] of Object.entries(params)) {
			expect(parsed.get(key)).toBe(String(value));
		}
	});

	it('keys with special chars survive the round-trip', () => {
		const url = client.image('card', { 'has space': 'v', 'a&b': 'v2' });
		const parsed = new URL(url).searchParams;
		expect(parsed.get('has space')).toBe('v');
		expect(parsed.get('a&b')).toBe('v2');
	});

	it('reserved underscore-prefixed params pass through as-is', () => {
		// The server's special-case handling for _v / _dpr / _strict
		// happens AFTER the same searchParams iteration the parity
		// test relies on, so as long as the round-trip preserves the
		// key the SDK doesn't need to know about the namespace.
		const url = client.image('card', { _v: 'abc123', _dpr: '2' });
		const parsed = new URL(url).searchParams;
		expect(parsed.get('_v')).toBe('abc123');
		expect(parsed.get('_dpr')).toBe('2');
	});
});

describe('CanvasClient.image() — slug validation', () => {
	const client = new CanvasClient({ baseUrl: 'https://canvas.example.com' });

	it.each([
		['empty string', ''],
		['whitespace only', '   '],
		['contains slash', 'og/card'],
		['contains backslash', 'og\\card'],
		['contains question mark', 'og?card'],
		['contains hash', 'og#card']
	])('rejects invalid slug: %s', (_label, slug) => {
		expect(() => client.image(slug)).toThrow(TypeError);
	});

	it('trims whitespace from a valid slug', () => {
		expect(client.image('  og-card  ')).toBe(
			'https://canvas.example.com/c/og-card/image.png'
		);
	});
});
