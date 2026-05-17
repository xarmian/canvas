/**
 * Render endpoint throttle (TASK-72). Verifies:
 * - X-RateLimit headers appear on a successful render.
 * - Hammering with cache-busting params eventually returns 429 with
 *   Retry-After once the per-IP token bucket is exhausted.
 *
 * The playwright webServer runs with RENDER_RATE_PER_MIN=5 so this test
 * trips the limit in <10 requests instead of >60. Concurrency cap and
 * queue-timeout 503s are exercised at the unit-of-test level (different
 * from this e2e because they need raw socket pressure that's awkward to
 * portably simulate from Playwright).
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, publish, uniqueXffHeaders } from './helpers';

// Override the suite-wide unique XFF (set in playwright.config.ts via
// extraHTTPHeaders) — this test specifically needs to PIN one IP across
// all of its requests so it can drain that IP's bucket. Other tests get
// a per-test XFF for isolation; this one supplies its own.
const fixedHeaders = uniqueXffHeaders();
test.use({ extraHTTPHeaders: fixedHeaders });

test.describe('Render throttle', () => {
	test('rate-limit headers + 429 after burst', async ({ page }) => {
		await signupAndLogin(page);
		await createCanvas(page);
		const { imageUrl } = await publish(page);

		const ctx = page.request;
		// Unique X-Forwarded-For so this test owns its rate-limit bucket
		// (RATE_PER_MIN=5 in playwright.config.ts). Other render-touching
		// tests do the same — sharing 127.0.0.1 would have them race for
		// the same 5 tokens.
		const headers = uniqueXffHeaders();

		// First render: 200 with rate-limit headers populated.
		const first = await ctx.get(`${imageUrl}?p=1`, { headers });
		expect(first.status()).toBe(200);
		expect(first.headers()['x-ratelimit-limit']).toBe('5');
		// Remaining is 4 right after the first decrement.
		expect(first.headers()['x-ratelimit-remaining']).toBe('4');

		// Drain the rest of the bucket sequentially (cache-busting params
		// so each is a render that costs a token). We expect 4 more
		// successful renders (p=2..5), then p=6 gets 429.
		for (let i = 2; i <= 5; i++) {
			const res = await ctx.get(`${imageUrl}?p=${i}`, { headers });
			expect(res.status()).toBe(200);
		}
		const overflow = await ctx.get(`${imageUrl}?p=6`, { headers });
		expect(overflow.status()).toBe(429);
		expect(overflow.headers()['retry-after']).toBeTruthy();
		expect(overflow.headers()['x-ratelimit-limit']).toBe('5');
		expect(overflow.headers()['x-ratelimit-remaining']).toBe('0');

		// Cache hits don't count: re-fetching ?p=1 (which is a HIT) should
		// succeed even though the bucket is empty.
		const cachedHit = await ctx.get(`${imageUrl}?p=1`, { headers });
		expect(cachedHit.status()).toBe(200);
		expect(cachedHit.headers()['x-cache']).toBe('HIT');
	});
});
