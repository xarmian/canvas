/**
 * Tests for the `signedUrl()` stub. The method is a typed
 * placeholder; the real implementation lands in IDEA-205. These
 * tests lock the runtime behavior (rejection with a specific
 * message) so the eventual implementation knows what it's replacing
 * and so consumers writing call-sites against the stub get a
 * deterministic failure mode today.
 */
import { describe, expect, it } from 'vitest';
import { CanvasClient } from './index.js';

describe('CanvasClient.signedUrl() — stub (TASK-224)', () => {
	const client = new CanvasClient({
		baseUrl: 'https://canvas.example.com',
		apiKey: 'sk_test_abc'
	});

	it('rejects with the documented error message', async () => {
		await expect(client.signedUrl('og-card', {}, { expiresIn: 60 })).rejects.toThrow(
			'signedUrl is not yet implemented — see IDEA-205'
		);
	});

	it('rejects asynchronously (returns a Promise, not a sync throw)', async () => {
		// The async-rejection contract matters: callers using `await`
		// must see a rejection, not have the call expression throw
		// synchronously and skip their try/catch. The eventual
		// IDEA-205 impl is expected to be async (Web Crypto signing),
		// so the stub matches that contract verbatim.
		const result = client.signedUrl('og-card', {}, { expiresIn: 60 });
		expect(result).toBeInstanceOf(Promise);
		// Drain the rejection to keep vitest's unhandled-rejection
		// guard quiet.
		await expect(result).rejects.toThrow();
	});

	it.each([
		['expiresIn', { expiresIn: 60 }],
		['expiresAt (epoch ms)', { expiresAt: Date.now() + 60_000 }],
		['expiresAt (ISO string)', { expiresAt: '2026-12-31T00:00:00Z' }]
	])('accepts the documented argument shape: %s', async (_label, opts) => {
		// TypeScript-side guarantee that the surface compiles for
		// every supported call-site. Drain the rejection so the
		// Promise doesn't surface as unhandled.
		const promise = client.signedUrl('og-card', { title: 'Hello' }, opts);
		await expect(promise).rejects.toThrow();
	});
});
