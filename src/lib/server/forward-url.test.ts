import { describe, it, expect } from 'vitest';
import { findUnsubstitutedPlaceholders, resolveForwardUrl, substituteParams } from './forward-url';

describe('substituteParams', () => {
	it('replaces {{key}} placeholders with their param values', () => {
		expect(substituteParams('https://example.com/{{slug}}', { slug: 'hello' })).toBe(
			'https://example.com/hello'
		);
	});

	it('substitutes the same placeholder multiple times', () => {
		expect(substituteParams('{{a}}/{{a}}', { a: 'x' })).toBe('x/x');
	});

	it('substitutes missing keys to the empty string (preserves legacy behavior)', () => {
		expect(substituteParams('a/{{missing}}/b', {})).toBe('a//b');
	});

	it('supports hyphenated placeholder keys like {{utm-source}}', () => {
		expect(substituteParams('?u={{utm-source}}', { 'utm-source': 'site' })).toBe('?u=site');
	});

	it('leaves a string with no placeholders unchanged', () => {
		expect(substituteParams('plain text', { x: '1' })).toBe('plain text');
	});

	it('treats a placeholder bound to the empty string as a real (empty) value', () => {
		expect(substituteParams('a/{{x}}/b', { x: '' })).toBe('a//b');
	});
});

describe('findUnsubstitutedPlaceholders', () => {
	it('returns placeholders missing from params', () => {
		expect(findUnsubstitutedPlaceholders('{{a}}{{b}}', { a: '1' })).toEqual(['b']);
	});

	it('returns the empty array when every placeholder is bound', () => {
		expect(findUnsubstitutedPlaceholders('{{a}}{{b}}', { a: '1', b: '2' })).toEqual([]);
	});

	it('de-duplicates repeated missing placeholders', () => {
		expect(findUnsubstitutedPlaceholders('{{x}}/{{x}}', {})).toEqual(['x']);
	});

	it('returns the empty array for a template with no placeholders', () => {
		expect(findUnsubstitutedPlaceholders('static', { a: '1' })).toEqual([]);
	});

	it('treats an explicit empty-string param as bound (not missing)', () => {
		expect(findUnsubstitutedPlaceholders('{{a}}', { a: '' })).toEqual([]);
	});
});

describe('resolveForwardUrl', () => {
	it('returns null when rawTemplate is null', () => {
		expect(resolveForwardUrl(null, {})).toBeNull();
	});

	it('returns null when rawTemplate is the empty string (matches legacy falsy gate)', () => {
		expect(resolveForwardUrl('', {})).toBeNull();
	});

	it('returns ok:true for an http URL', () => {
		const result = resolveForwardUrl('http://example.com/x', {});
		expect(result).toEqual({ ok: true, url: 'http://example.com/x', unsubstituted: [] });
	});

	it('returns ok:true for an https URL with full substitution', () => {
		const result = resolveForwardUrl('https://example.com/{{slug}}', { slug: 'hello' });
		expect(result).toEqual({
			ok: true,
			url: 'https://example.com/hello',
			unsubstituted: []
		});
	});

	it('reports unsubstituted keys but still returns ok:true when the URL parses as http(s)', () => {
		const result = resolveForwardUrl('https://example.com/{{slug}}?u={{utm}}', {
			slug: 'hello'
		});
		expect(result).toEqual({
			ok: true,
			url: 'https://example.com/hello?u=',
			unsubstituted: ['utm']
		});
	});

	for (const scheme of ['javascript', 'data', 'file', 'blob']) {
		it(`returns ok:false invalid-scheme for ${scheme}: URLs`, () => {
			const raw = `${scheme}:something`;
			const result = resolveForwardUrl(raw, {});
			expect(result).toEqual({
				ok: false,
				reason: 'invalid-scheme',
				resolved: raw,
				unsubstituted: []
			});
		});
	}

	it('returns ok:false invalid-scheme even when a {{param}} smuggles javascript: through', () => {
		const result = resolveForwardUrl('{{evil}}', { evil: 'javascript:alert(1)' });
		expect(result).toEqual({
			ok: false,
			reason: 'invalid-scheme',
			resolved: 'javascript:alert(1)',
			unsubstituted: []
		});
	});

	it('returns ok:false unparseable for a bare placeholder that did not resolve', () => {
		const result = resolveForwardUrl('{{everything}}', {});
		expect(result).toEqual({
			ok: false,
			reason: 'unparseable',
			resolved: '',
			unsubstituted: ['everything']
		});
	});

	it('returns ok:false unparseable for free-form unparseable input', () => {
		const result = resolveForwardUrl('not a url at all', {});
		expect(result).toEqual({
			ok: false,
			reason: 'unparseable',
			resolved: 'not a url at all',
			unsubstituted: []
		});
	});
});
