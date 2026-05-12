import { describe, it, expect } from 'vitest';
import { buildContentHashInputs, FORMAT_EXTENSIONS } from './baked-render';

describe('buildContentHashInputs', () => {
	const base = {
		userId: 'u1',
		canvasId: 'c1',
		canvasVersion: '2026-01-01T00:00:00.000Z',
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

	it('distinguishes null vs empty-string forwardUrl (post-JSON unambiguous)', () => {
		// Earlier `join('|')`-based input collapsed these together. JSON
		// distinguishes `null` from `""` so the hashes differ now.
		expect(buildContentHashInputs({ ...base, forwardUrl: null })).not.toBe(
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

	it('distinguishes between canvas versions so an edit busts dedup', () => {
		expect(buildContentHashInputs(base)).not.toBe(
			buildContentHashInputs({ ...base, canvasVersion: '2026-02-02T00:00:00.000Z' })
		);
	});

	it('is unambiguous against `|`-containing inputs (regression: Codex round 1 P2)', () => {
		// Earlier `join('|')`-based serialization let these two distinct
		// field sets collide. JSON encoding guarantees they don't.
		const a = buildContentHashInputs({ ...base, forwardUrl: 'https://ex.com/a|b' });
		const b = buildContentHashInputs({ ...base, forwardUrl: 'https://ex.com/a', ogTitle: 'b' });
		expect(a).not.toBe(b);
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
