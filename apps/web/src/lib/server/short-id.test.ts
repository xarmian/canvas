import { describe, it, expect } from 'vitest';
import { generateShortId, withUniqueShortId } from './short-id';

describe('generateShortId', () => {
	it('returns a 10-char URL-safe id', () => {
		const id = generateShortId();
		expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
	});

	it('returns a different id on each call', () => {
		const samples = new Set<string>();
		for (let i = 0; i < 200; i++) samples.add(generateShortId());
		expect(samples.size).toBe(200);
	});
});

describe('withUniqueShortId', () => {
	it('returns the value when the first attempt succeeds', async () => {
		let calls = 0;
		const result = await withUniqueShortId(async (id) => {
			calls += 1;
			return id.length;
		});
		expect(result).toBe(10);
		expect(calls).toBe(1);
	});

	it('retries on collision until success', async () => {
		let calls = 0;
		const result = await withUniqueShortId(async (id) => {
			calls += 1;
			if (calls < 3)
				throw new Error('duplicate key value violates rendered_images_short_id_unique');
			return id;
		});
		expect(typeof result).toBe('string');
		expect(calls).toBe(3);
	});

	it('propagates non-collision errors immediately', async () => {
		await expect(
			withUniqueShortId(async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
	});

	it('gives up after maxAttempts collisions', async () => {
		let calls = 0;
		await expect(
			withUniqueShortId(
				async () => {
					calls += 1;
					throw new Error('rendered_images_short_id_unique');
				},
				{ maxAttempts: 4 }
			)
		).rejects.toThrow(/short_id_unique/);
		expect(calls).toBe(4);
	});

	it('respects a custom isCollision predicate', async () => {
		let calls = 0;
		await expect(
			withUniqueShortId(
				async () => {
					calls += 1;
					if (calls < 2) throw new Error('e2e custom collision');
					return 'ok';
				},
				{ isCollision: (err) => (err as Error).message.includes('custom collision') }
			)
		).resolves.toBe('ok');
		expect(calls).toBe(2);
	});
});
