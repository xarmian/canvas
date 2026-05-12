import { describe, it, expect } from 'vitest';
import { buildContentHashInputs, FORMAT_EXTENSIONS } from './baked-render';

describe('buildContentHashInputs', () => {
	const base = {
		userId: 'u1',
		canvasId: 'c1',
		params: { title: 'hello', avatar: 'x' },
		format: 'png',
		dpr: 1,
		forwardUrl: null,
		ogTitle: null,
		ogDescription: null
	};

	it('produces the same string for identical inputs', () => {
		expect(buildContentHashInputs(base)).toBe(buildContentHashInputs(base));
	});

	it('is insensitive to param key insertion order (sorts internally)', () => {
		const a = buildContentHashInputs({ ...base, params: { a: '1', b: '2' } });
		const b = buildContentHashInputs({ ...base, params: { b: '2', a: '1' } });
		expect(a).toBe(b);
	});

	it('distinguishes between formats', () => {
		expect(buildContentHashInputs({ ...base, format: 'png' })).not.toBe(
			buildContentHashInputs({ ...base, format: 'jpeg' })
		);
	});

	it('distinguishes between dpr values', () => {
		expect(buildContentHashInputs({ ...base, dpr: 1 })).not.toBe(
			buildContentHashInputs({ ...base, dpr: 2 })
		);
	});

	it('distinguishes between forwardUrl null and an empty-string-ish url', () => {
		expect(buildContentHashInputs({ ...base, forwardUrl: null })).toBe(
			buildContentHashInputs({ ...base, forwardUrl: '' })
		);
		// Two truly different forwardUrls must produce different hashes.
		expect(buildContentHashInputs({ ...base, forwardUrl: 'https://a' })).not.toBe(
			buildContentHashInputs({ ...base, forwardUrl: 'https://b' })
		);
	});

	it('distinguishes between users so renders never alias across accounts', () => {
		expect(buildContentHashInputs(base)).not.toBe(
			buildContentHashInputs({ ...base, userId: 'u2' })
		);
	});
});

describe('FORMAT_EXTENSIONS', () => {
	it('maps every supported format to a non-empty ext + image MIME', () => {
		for (const format of ['png', 'jpeg', 'webp', 'avif'] as const) {
			const entry = FORMAT_EXTENSIONS[format];
			expect(entry).toBeDefined();
			expect(entry.ext.length).toBeGreaterThan(0);
			expect(entry.contentType.startsWith('image/')).toBe(true);
		}
	});

	it('uses `jpg` (not `jpeg`) as the storage-key extension for JPEG', () => {
		expect(FORMAT_EXTENSIONS.jpeg.ext).toBe('jpg');
	});
});
