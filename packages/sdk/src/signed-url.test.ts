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

	it('accepts expiresIn form', async () => {
		const promise = client.signedUrl('og-card', { title: 'Hello' }, { expiresIn: 60 });
		await expect(promise).rejects.toThrow();
	});

	it('accepts expiresAt as epoch ms', async () => {
		const promise = client.signedUrl(
			'og-card',
			{ title: 'Hello' },
			{ expiresAt: Date.now() + 60_000 }
		);
		await expect(promise).rejects.toThrow();
	});

	it('accepts expiresAt as ISO string', async () => {
		const promise = client.signedUrl(
			'og-card',
			{ title: 'Hello' },
			{ expiresAt: '2026-12-31T00:00:00Z' }
		);
		await expect(promise).rejects.toThrow();
	});

	it('TYPE: rejects neither / both expiry forms at compile time (Codex round 1)', async () => {
		// `@ts-expect-error` is itself the assertion — `tsc --noEmit`
		// fails if these comments are present on a line that DOESN'T
		// produce an error, so this test passes only if the union
		// types correctly forbid invalid shapes.

		// Neither — must have at least one.
		// @ts-expect-error — `expiresIn` or `expiresAt` is required.
		const p1 = client.signedUrl('og-card', {}, {});
		// Both — exclusive union rejects this.
		const p2 = client.signedUrl(
			'og-card',
			{},
			// @ts-expect-error — cannot supply both expiresIn AND expiresAt.
			{ expiresIn: 60, expiresAt: Date.now() + 60_000 }
		);
		// Drain the rejections so vitest doesn't flag them.
		await Promise.allSettled([p1, p2]);
	});
});
