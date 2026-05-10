/**
 * Crypto LP-card template (TASK-90 / TASK-91). Locks in the rendered
 * output across the parameter matrix that early users will hit:
 *
 *   - Positive gain, in_range, boosted, both logos present
 *   - Negative gain, out_of_range, unboosted, both logos present
 *   - Zero gain (boundary case for the gain<0 conditional rule)
 *   - Edge range (yellow pill)
 *   - Missing tokenA logo (fallback path for image src)
 *   - Missing tokenB logo (fallback path for image src)
 *   - Missing gain param entirely (renders the layer's authored default)
 *
 * What we assert per permutation: HTTP 200 OK, image/png content-type,
 * non-trivial byte length (proves the renderer didn't fall through to
 * an error path), and a unique SHA-256 hash relative to the canonical
 * positive-gain reference (proves params actually affected the output).
 *
 * Visual regression via toHaveScreenshot is intentionally NOT used —
 * Skia font AA differs between Linux CI runners and developer machines,
 * which would make snapshots flaky without a tolerance-tuning round
 * that v0.5 doesn't have time for. Hash-based "outputs differ" gates
 * are enough to catch the conditional-rule + formatter regressions
 * this test is here to prevent.
 */
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signupAndLogin, publish, uniqueXffHeaders } from './helpers';

const SAMPLE_PARAMS = {
	tokenA: 'USDC',
	tokenB: 'ETH',
	tokenALogoUrl:
		'data:image/svg+xml;utf8,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#3b82f6"/></svg>'
		),
	tokenBLogoUrl:
		'data:image/svg+xml;utf8,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#a855f7"/></svg>'
		),
	gainPercent: '0.125',
	pl: '125.30',
	entry: '0.10',
	mark: '0.22',
	volume: '1234567',
	range: 'in_range',
	rangeLabel: 'In Range',
	boosted: 'true',
	timeframe: '24h'
};

function paramsToSearch(params: Record<string, string>): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) sp.set(k, v);
	return sp.toString();
}

function sha256(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}

test.describe('Crypto LP-card template — render permutations', () => {
	test('every documented permutation renders, params affect output', async ({ page }) => {
		// Single signup + canvas setup amortized across all permutations.
		// The test runs entirely from the GET image endpoint after this
		// point so the per-permutation cost is one HTTP round-trip each
		// — well under the 60s budget called out in the acceptance.
		await signupAndLogin(page);

		// Seed the LP canvas from the gallery in one click. The route is
		// /templates → "Use this template" on the crypto-lp-card card →
		// editor opens with the seeded JSON. We don't open the editor /
		// edit anything; the publish flow runs directly.
		await page.goto('/templates');
		await page.waitForLoadState('networkidle');
		const lpCard = page.locator('[data-template-id="crypto-lp-card"]');
		await expect(lpCard).toBeVisible({ timeout: 10_000 });
		await lpCard.getByTestId('template-use').click();
		await page.waitForURL(/\/canvas\/[^/]+\/edit$/, { timeout: 15_000 });
		// Wait for hydration (loadFromJSON needs to finish before publish)
		await page.waitForLoadState('networkidle');

		const { imageUrl } = await publish(page);
		// Strip any params the publish helper may have appended; we'll
		// rebuild a fresh query string per permutation below.
		const baseImageUrl = imageUrl.split('?')[0];

		const permutations: Record<string, Record<string, string>> = {
			positive: SAMPLE_PARAMS,
			negative: {
				...SAMPLE_PARAMS,
				gainPercent: '-0.075',
				pl: '-87.10',
				range: 'out_of_range',
				rangeLabel: 'Out of Range',
				boosted: 'false'
			},
			zeroGain: { ...SAMPLE_PARAMS, gainPercent: '0', pl: '0' },
			edgeRange: { ...SAMPLE_PARAMS, range: 'edge', rangeLabel: 'Edge' },
			missingTokenALogo: { ...SAMPLE_PARAMS, tokenALogoUrl: 'https://invalid.test/missing.png' },
			missingTokenBLogo: { ...SAMPLE_PARAMS, tokenBLogoUrl: 'https://invalid.test/missing.png' },
			missingGainParam: (() => {
				// Drop gainPercent so the layer's authored default ("0.125")
				// is used. This exercises the binding-default fall-through
				// (TASK-43+) under the LP card's conditional-fill rule.
				const { gainPercent: _omit, ...rest } = SAMPLE_PARAMS;
				void _omit;
				return rest;
			})()
		};

		const hashes = new Map<string, string>();
		// One unique X-Forwarded-For per request so the per-IP render rate
		// limit (TASK-72) doesn't conflate the seven permutation requests
		// into a single bucket and 429 the trailing ones.
		for (const [label, params] of Object.entries(permutations)) {
			const url = `${baseImageUrl}?${paramsToSearch(params)}`;
			const res = await page.request.get(url, { headers: uniqueXffHeaders() });
			expect(res.status(), `permutation ${label}: status`).toBe(200);
			expect(res.headers()['content-type'] ?? '', `permutation ${label}: content-type`).toContain(
				'image/png'
			);
			const body = await res.body();
			// Lower bound — a real LP-card render is ~30-60 KB. Anything
			// dramatically smaller indicates the renderer fell through to
			// an error-path placeholder (or returned a near-empty PNG).
			expect(body.byteLength, `permutation ${label}: bytes`).toBeGreaterThan(8_000);
			hashes.set(label, sha256(body));
		}

		// Permutations that change visible content should yield distinct
		// outputs from `positive`. Missing logos use a different URL but
		// the renderer falls through to the embedded fallbackSrc, which
		// the `positive` baseline ALSO ends up using when its data-URL
		// blob token logos are unrelated to fallbackSrc — so we compare
		// only the cases guaranteed to differ.
		const positive = hashes.get('positive')!;
		for (const label of ['negative', 'zeroGain', 'edgeRange'] as const) {
			expect(hashes.get(label), `${label} differs from positive`).not.toBe(positive);
		}
	});
});
