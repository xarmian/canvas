import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	checkApiKeyRateLimit,
	RENDER_THROTTLE_CONFIG,
	resetRenderThrottleStateForTesting
} from './render-throttle';

describe('checkApiKeyRateLimit', () => {
	beforeEach(() => {
		resetRenderThrottleStateForTesting();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('first request returns allowed with full burst as remaining', () => {
		const res = checkApiKeyRateLimit('key-a', 'write');
		expect(res.allowed).toBe(true);
		if (res.allowed) {
			expect(res.limit).toBe(RENDER_THROTTLE_CONFIG.apiKeyBurst);
			expect(res.remaining).toBe(RENDER_THROTTLE_CONFIG.apiKeyBurst - 1);
		}
	});

	it('exhausts the burst then returns 429 with Retry-After', () => {
		const burst = RENDER_THROTTLE_CONFIG.apiKeyBurst;
		for (let i = 0; i < burst; i++) {
			const r = checkApiKeyRateLimit('key-b', 'write');
			expect(r.allowed).toBe(true);
		}
		const exhausted = checkApiKeyRateLimit('key-b', 'write');
		expect(exhausted.allowed).toBe(false);
		if (!exhausted.allowed) {
			expect(exhausted.retryAfterSeconds).toBeGreaterThanOrEqual(1);
			expect(exhausted.limit).toBe(burst);
		}
	});

	it('refills tokens over time at the configured rate', () => {
		const burst = RENDER_THROTTLE_CONFIG.apiKeyBurst;
		for (let i = 0; i < burst; i++) checkApiKeyRateLimit('key-c', 'write');
		// Hammer hit the cap → 429
		expect(checkApiKeyRateLimit('key-c', 'write').allowed).toBe(false);
		// Advance enough to refill at least one token (rate-per-min / 60 / 1000 per ms).
		// Two minutes is plenty even at the floor configuration.
		vi.advanceTimersByTime(2 * 60 * 1000);
		expect(checkApiKeyRateLimit('key-c', 'write').allowed).toBe(true);
	});

	it('write and read buckets are independent for the same key', () => {
		const burst = RENDER_THROTTLE_CONFIG.apiKeyBurst;
		for (let i = 0; i < burst; i++) checkApiKeyRateLimit('key-d', 'write');
		// Write is exhausted now…
		expect(checkApiKeyRateLimit('key-d', 'write').allowed).toBe(false);
		// …but reads still have full headroom.
		expect(checkApiKeyRateLimit('key-d', 'read').allowed).toBe(true);
	});

	it('reads get a higher limit than writes (5x multiplier)', () => {
		const writeRes = checkApiKeyRateLimit('key-e', 'write');
		const readRes = checkApiKeyRateLimit('key-e', 'read');
		expect(writeRes.allowed).toBe(true);
		expect(readRes.allowed).toBe(true);
		if (writeRes.allowed && readRes.allowed) {
			expect(readRes.limit).toBe(writeRes.limit * 5);
		}
	});

	it('different keys have independent buckets', () => {
		const burst = RENDER_THROTTLE_CONFIG.apiKeyBurst;
		for (let i = 0; i < burst; i++) checkApiKeyRateLimit('key-f', 'write');
		expect(checkApiKeyRateLimit('key-f', 'write').allowed).toBe(false);
		// `key-g` has never been seen — should be allowed.
		expect(checkApiKeyRateLimit('key-g', 'write').allowed).toBe(true);
	});

	it('an exhausted bucket reset after the idle window starts fresh', () => {
		const burst = RENDER_THROTTLE_CONFIG.apiKeyBurst;
		for (let i = 0; i < burst; i++) checkApiKeyRateLimit('key-h', 'write');
		expect(checkApiKeyRateLimit('key-h', 'write').allowed).toBe(false);
		// Advance past the idle reset (1 hour) — the bucket is wiped to
		// the burst cap on next access.
		vi.advanceTimersByTime(70 * 60 * 1000);
		const after = checkApiKeyRateLimit('key-h', 'write');
		expect(after.allowed).toBe(true);
		if (after.allowed) {
			expect(after.remaining).toBe(burst - 1);
		}
	});
});
