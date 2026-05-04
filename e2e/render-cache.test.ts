/**
 * Filesystem render cache (TASK-53). Verifies the X-Cache header
 * transitions MISS → HIT for repeated identical requests, that
 * different params cache independently, and that the cache directory
 * actually grows on disk (proxy for "survives restart").
 */
import { test, expect } from '@playwright/test';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer, publish } from './helpers';

const CACHE_DIR = './.cache/render';

async function dirSize(dir: string): Promise<number> {
	let total = 0;
	try {
		const shards = await readdir(dir, { withFileTypes: true });
		for (const s of shards) {
			if (!s.isDirectory()) continue;
			const files = await readdir(join(dir, s.name));
			for (const f of files) {
				const st = await stat(join(dir, s.name, f));
				if (st.isFile()) total += st.size;
			}
		}
	} catch {
		// dir doesn't exist yet
	}
	return total;
}

test('render cache: MISS → HIT, distinct keys, persists to disk', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Cache RT', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'Cache me');
	const { imageUrl } = await publish(page);

	const sizeBefore = await dirSize(CACHE_DIR);

	// 1. First fetch: MISS — render runs, byte response served, cache
	// receives a write afterwards.
	const first = await request.get(imageUrl);
	expect(first.status()).toBe(200);
	expect(first.headers()['x-cache']).toBe('MISS');

	// 2. Second fetch (same URL): HIT — served from disk cache.
	const second = await request.get(imageUrl);
	expect(second.status()).toBe(200);
	expect(second.headers()['x-cache']).toBe('HIT');
	// Bytes match exactly — same render.
	expect((await first.body()).equals(await second.body())).toBe(true);

	// 3. Different params hash to a different cache entry → MISS again.
	const distinct = await request.get(`${imageUrl}?title=Other`);
	expect(distinct.status()).toBe(200);
	expect(distinct.headers()['x-cache']).toBe('MISS');

	// 4. Cache dir grew. Proxy for "survives restart" — files exist on
	// disk, not just in memory. (A full restart-and-reread test would
	// need to bounce the server mid-test; this is enough to prove the
	// FS path works.)
	const sizeAfter = await dirSize(CACHE_DIR);
	expect(sizeAfter).toBeGreaterThan(sizeBefore);
});
