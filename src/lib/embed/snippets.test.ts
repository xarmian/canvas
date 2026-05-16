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
