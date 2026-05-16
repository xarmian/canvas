import { describe, it, expect } from 'vitest';
import {
	buildQueryString,
	composeImageUrl,
	htmlSnippet,
	markdownSnippet,
	ogSnippet,
	urlSnippet,
	curlSnippet,
	curlFor,
	tsSimple,
	tsTyped,
	type ParamSchema,
	type SnippetInput
} from './snippets';

/** Build a fully-populated SnippetInput so tests only have to override
 * the fields they care about. The defaults match a realistic
 * "published canvas at canvas.example.com with two params" scenario. */
function input(overrides: Partial<SnippetInput> = {}): SnippetInput {
	return {
		imageUrl: 'https://canvas.example.com/c/card/image.png',
		shareUrl: 'https://canvas.example.com/c/card',
		slug: 'card',
		query: '?title=Hello&avatar=https%3A%2F%2Fx',
		params: { title: 'Hello', avatar: 'https://x' },
		versionToken: null,
		includeParams: true,
		...overrides
	};
}

describe('buildQueryString', () => {
	it('returns empty string for an empty map', () => {
		expect(buildQueryString({})).toBe('');
	});

	it('URL-encodes spaces in both keys and values', () => {
		// Encoded space in key tests that the renderer's strict-mode
		// `params['hi there']` lookup path stays addressable from the
		// snippet. We don't trim whitespace — see PublishModal's
		// collectBoundParams comment for the reasoning.
		expect(buildQueryString({ 'hi there': 'My Token' })).toBe('?hi%20there=My%20Token');
	});

	it('URL-encodes percent signs so "+12.5%" doesn\'t collide with form-encoding', () => {
		expect(buildQueryString({ gain: '+12.5%' })).toBe('?gain=%2B12.5%25');
	});

	it('URL-encodes "+" so it survives form-decoding as a literal plus, not a space', () => {
		// Bug magnet: `decodeURIComponent('+')` returns '+', but
		// `URLSearchParams.get('a')` on `'a=+'` returns ' '. Pad's
		// renderer uses URLSearchParams; we must encode '+' as %2B so
		// `params.title === '+Hello'` matches what the user typed.
		expect(buildQueryString({ title: '+Hello' })).toBe('?title=%2BHello');
	});

	it('handles unicode codepoints', () => {
		expect(buildQueryString({ name: '日本語' })).toBe('?name=%E6%97%A5%E6%9C%AC%E8%AA%9E');
		expect(buildQueryString({ emoji: '🦊' })).toBe('?emoji=%F0%9F%A6%8A');
	});

	it('skips empty keys but keeps empty values verbatim', () => {
		// Empty key would never be looked up at runtime, so we drop it.
		// Empty value is meaningful — `?title=` forces empty-string
		// rather than falling through to the binding default.
		expect(buildQueryString({ '': 'x', title: '' })).toBe('?title=');
	});

	it('preserves declaration order across keys', () => {
		// Snippets read top-to-bottom; deterministic ordering keeps
		// diff-friendly output between renders of the same modal.
		const params = { c: '3', a: '1', b: '2' };
		expect(buildQueryString(params)).toBe('?c=3&a=1&b=2');
	});
});

describe('composeImageUrl', () => {
	it('returns the bare image URL when includeParams is false and no version token', () => {
		expect(composeImageUrl(input({ includeParams: false }))).toBe(
			'https://canvas.example.com/c/card/image.png'
		);
	});

	it('appends the query when includeParams is true', () => {
		expect(composeImageUrl(input())).toBe(
			'https://canvas.example.com/c/card/image.png?title=Hello&avatar=https%3A%2F%2Fx'
		);
	});

	it('appends &_v= when a query is present and a version token is set', () => {
		expect(composeImageUrl(input({ versionToken: 'abc123' }))).toBe(
			'https://canvas.example.com/c/card/image.png?title=Hello&avatar=https%3A%2F%2Fx&_v=abc123'
		);
	});

	it('appends ?_v= when no query is present and a version token is set', () => {
		expect(composeImageUrl(input({ includeParams: false, versionToken: 'abc123' }))).toBe(
			'https://canvas.example.com/c/card/image.png?_v=abc123'
		);
	});

	it('treats empty-string versionToken as "no token" (no _v appended)', () => {
		expect(composeImageUrl(input({ versionToken: '' }))).toBe(
			'https://canvas.example.com/c/card/image.png?title=Hello&avatar=https%3A%2F%2Fx'
		);
	});

	it('handles .jpg / .webp / .avif image URLs without modification', () => {
		// composeImageUrl doesn't pick a format — the caller bakes that
		// into `imageUrl`. We assert format-agnosticism so the upcoming
		// format-switcher just passes a different `imageUrl` and the
		// rest of the pipeline keeps working.
		expect(composeImageUrl(input({ imageUrl: 'https://x/c/y/image.webp' }))).toBe(
			'https://x/c/y/image.webp?title=Hello&avatar=https%3A%2F%2Fx'
		);
	});
});

describe('htmlSnippet', () => {
	it('emits a 1200x630 <img> tag using the composed URL', () => {
		expect(htmlSnippet(input())).toBe(
			'<img src="https://canvas.example.com/c/card/image.png?title=Hello&avatar=https%3A%2F%2Fx" alt="Canvas: card" width="1200" height="630" />'
		);
	});

	it('uses the bare image URL when includeParams is off', () => {
		expect(htmlSnippet(input({ includeParams: false }))).toBe(
			'<img src="https://canvas.example.com/c/card/image.png" alt="Canvas: card" width="1200" height="630" />'
		);
	});
});

describe('markdownSnippet', () => {
	it('emits an alt-tagged markdown image link', () => {
		expect(markdownSnippet(input())).toBe(
			'![Canvas: card](https://canvas.example.com/c/card/image.png?title=Hello&avatar=https%3A%2F%2Fx)'
		);
	});
});

describe('ogSnippet', () => {
	it('emits the four canonical og tags + og:url when http (no secure_url)', () => {
		const out = ogSnippet(
			input({
				imageUrl: 'http://localhost:5173/c/card/image.png',
				shareUrl: 'http://localhost:5173/c/card'
			})
		);
		expect(out).toContain(
			'<meta property="og:image" content="http://localhost:5173/c/card/image.png?title=Hello&avatar=https%3A%2F%2Fx" />'
		);
		expect(out).toContain('<meta property="og:image:width" content="1200" />');
		expect(out).toContain('<meta property="og:image:height" content="630" />');
		expect(out).toContain('<meta property="og:image:type" content="image/png" />');
		expect(out).not.toContain('og:image:secure_url');
		expect(out).toContain(
			'<meta property="og:url" content="http://localhost:5173/c/card?title=Hello&avatar=https%3A%2F%2Fx" />'
		);
	});

	it('adds og:image:secure_url when the URL is https', () => {
		const out = ogSnippet(input());
		expect(out).toContain('<meta property="og:image:secure_url"');
	});

	it('emits the BARE share URL in og:url when includeParams is off', () => {
		// Otherwise a parameterized og:image variant would canonicalize
		// back to the unparameterized page — see ogSnippet docstring.
		const out = ogSnippet(input({ includeParams: false }));
		expect(out).toContain('<meta property="og:url" content="https://canvas.example.com/c/card" />');
	});
});

describe('urlSnippet', () => {
	it('is just the composed image URL', () => {
		expect(urlSnippet(input())).toBe(composeImageUrl(input()));
	});
});

describe('curlSnippet', () => {
	it('wraps the composed URL in a single-quoted curl command', () => {
		expect(curlSnippet(input())).toBe(
			"curl -o canvas.png 'https://canvas.example.com/c/card/image.png?title=Hello&avatar=https%3A%2F%2Fx'"
		);
	});
});

describe('tsSimple', () => {
	it('emits a Record<string,string> + URLSearchParams fetch when params are present', () => {
		const out = tsSimple(input());
		expect(out).toContain('const params: Record<string, string> = {');
		expect(out).toContain("\ttitle: 'Hello'");
		expect(out).toContain("\tavatar: 'https://x'");
		expect(out).toContain('new URLSearchParams(params)');
		expect(out).toContain('await fetch(url)');
		expect(out).toContain('await res.blob()');
	});

	it('quotes object keys that are not valid JS identifiers', () => {
		const out = tsSimple(input({ params: { 'my-key': 'v', '1bad': 'w' } }));
		expect(out).toContain("'my-key': 'v'");
		expect(out).toContain("'1bad': 'w'");
	});

	it('backslash-escapes single quotes in string values', () => {
		// Belt-and-suspenders: URLSearchParams would percent-encode it on
		// the wire, but the snippet shows the raw value to the user.
		const out = tsSimple(input({ params: { name: "O'Brien" } }));
		expect(out).toContain("name: 'O\\'Brien'");
	});

	it('appends &_v=<token> to the URL when a version token is set', () => {
		const out = tsSimple(input({ versionToken: 'abc123' }));
		expect(out).toContain('}&_v=abc123`;');
	});

	it('falls back to a bare fetch when includeParams is off', () => {
		const out = tsSimple(input({ includeParams: false }));
		expect(out).not.toContain('URLSearchParams');
		expect(out).toContain("const url = 'https://canvas.example.com/c/card/image.png';");
		expect(out).toContain('await fetch(url)');
	});

	it('falls back to a bare fetch when there are no params', () => {
		const out = tsSimple(input({ params: {} }));
		expect(out).not.toContain('URLSearchParams');
		expect(out).toContain('await fetch(url)');
	});

	it('preserves the version token even when includeParams is off (single ?_v= form)', () => {
		const out = tsSimple(input({ includeParams: false, versionToken: 'tok' }));
		expect(out).toContain("const url = 'https://canvas.example.com/c/card/image.png?_v=tok';");
	});
});

describe('tsTyped', () => {
	const fullSchema: ParamSchema[] = [
		{ name: 'title', type: 'text' },
		{ name: 'avatar', type: 'url' },
		{ name: 'gain', type: 'number' },
		{ name: 'verified', type: 'boolean' },
		{ name: 'published_at', type: 'date' }
	];

	it('emits a typed Params object covering every schema entry', () => {
		const out = tsTyped(
			input({
				paramSchemas: fullSchema,
				params: {
					title: 'My Token',
					avatar: 'https://avatars/x.png',
					gain: '12.5',
					verified: 'true',
					published_at: '2026-01-15'
				}
			})
		);
		expect(out).toContain('type Params = {');
		expect(out).toContain('\ttitle: string;');
		expect(out).toContain('\tavatar: string;');
		expect(out).toContain('\tgain: number;');
		expect(out).toContain('\tverified: boolean;');
		expect(out).toContain('\tpublished_at: string;');
		expect(out).toContain('const params: Params = {');
		expect(out).toContain("\ttitle: 'My Token'");
		expect(out).toContain("\tavatar: 'https://avatars/x.png'");
		expect(out).toContain('\tgain: 12.5');
		expect(out).toContain('\tverified: true');
		expect(out).toContain("\tpublished_at: '2026-01-15'");
	});

	it('quotes the number when the raw value is not finite-numeric', () => {
		// Falling back to a quoted form keeps the snippet runnable: if the
		// type says number but the user typed "abc", emitting `abc` would
		// be a syntax error, so we re-emit as a string and let the type
		// error guide them.
		const out = tsTyped(
			input({
				paramSchemas: [{ name: 'gain', type: 'number' }],
				params: { gain: 'abc' }
			})
		);
		expect(out).toContain("\tgain: 'abc'");
	});

	it('coerces boolean strings (true/1/yes/on, case-insensitive) to true', () => {
		const schemas: ParamSchema[] = [
			{ name: 'a', type: 'boolean' },
			{ name: 'b', type: 'boolean' },
			{ name: 'c', type: 'boolean' },
			{ name: 'd', type: 'boolean' },
			{ name: 'e', type: 'boolean' }
		];
		const out = tsTyped(
			input({
				paramSchemas: schemas,
				params: { a: 'true', b: '1', c: 'YES', d: 'On', e: 'no' }
			})
		);
		expect(out).toContain('\ta: true');
		expect(out).toContain('\tb: true');
		expect(out).toContain('\tc: true');
		expect(out).toContain('\td: true');
		expect(out).toContain('\te: false');
	});

	it('falls back to string for keys present in params but missing from schema', () => {
		const out = tsTyped(
			input({
				paramSchemas: [{ name: 'title', type: 'text' }],
				params: { title: 'Hello', mystery: 'x' }
			})
		);
		expect(out).toContain('\ttitle: string;');
		expect(out).toContain('\tmystery: string;');
		expect(out).toContain("\tmystery: 'x'");
	});

	it('emits placeholder values for schema entries absent from params', () => {
		const out = tsTyped(
			input({
				paramSchemas: [
					{ name: 'title', type: 'text' },
					{ name: 'count', type: 'number' },
					{ name: 'live', type: 'boolean' }
				],
				params: { title: 'Hi' }
			})
		);
		expect(out).toContain('\tcount: number;');
		expect(out).toContain('\tlive: boolean;');
		expect(out).toContain('\tcount: 0');
		expect(out).toContain('\tlive: false');
	});

	it('falls back to all strings when no paramSchemas are supplied', () => {
		const out = tsTyped(
			input({
				paramSchemas: undefined,
				params: { title: 'Hello', gain: '12.5' }
			})
		);
		expect(out).toContain('\ttitle: string;');
		expect(out).toContain('\tgain: string;');
		expect(out).toContain("\tgain: '12.5'");
	});

	it('stringifies typed values for URLSearchParams (numbers and booleans pass through String())', () => {
		const out = tsTyped(
			input({
				paramSchemas: [{ name: 'gain', type: 'number' }],
				params: { gain: '12.5' }
			})
		);
		expect(out).toContain('new URLSearchParams(');
		expect(out).toContain('Object.fromEntries');
		expect(out).toContain('String(v)');
	});

	it('falls back to bare fetch when includeParams is off', () => {
		const out = tsTyped(
			input({ paramSchemas: [{ name: 'title', type: 'text' }], includeParams: false })
		);
		expect(out).not.toContain('type Params');
		expect(out).toContain('await fetch(url)');
	});
});

describe('curlFor', () => {
	it("escapes single quotes using ANSI-C `\\'\\\\\\'\\'` so the shell sees a literal quote", () => {
		// Belt-and-suspenders: URL encoding already turns ' into %27 in
		// real snippets, but curlFor is a free function that any caller
		// could hand a raw URL to.
		expect(curlFor("https://x/y?title=O'Brien")).toBe(
			`curl -o canvas.png 'https://x/y?title=O'\\''Brien'`
		);
	});
});
