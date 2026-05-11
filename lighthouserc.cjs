/**
 * Lighthouse CI config — mobile floor for the public-facing surfaces
 * (TASK-140 under PLAN-84 / TASK-113).
 *
 * Goals:
 *
 *   1. Provide a guardrail so the mobile work shipped under TASK-138
 *      and TASK-139 doesn't silently regress on later PRs.
 *   2. Keep the floor narrow enough that author-time CI doesn't tip
 *      over on cold caches or transient noise — set to numbers we
 *      actually clear today, not aspirational targets.
 *
 * Scope:
 *
 *   - `/` (public landing) — the most-trafficked unauth surface.
 *
 *   - `/c/{slug}` is NOT audited here yet. It needs a seeded
 *     published canvas in the test DB and the dynamic image URL
 *     must actually render, which means standing up postgres +
 *     running a seed script before the LHCI run. That's significantly
 *     more CI setup than this PR wants to take on. Tracked for
 *     follow-up — listed in the TASK-140 acceptance and revisited
 *     once we have a stable seed harness.
 *
 * Execution shape:
 *
 *   - Run with `pnpm lh:mobile` locally or via the
 *     `.github/workflows/lighthouse.yml` Actions job.
 *   - `startServerCommand` runs the production-preview server
 *     (`vite preview`) rather than `vite dev` so audited numbers
 *     reflect the shipped bundle, not dev-mode HMR / source maps /
 *     unminified output.
 *   - Three runs per URL to dampen single-run noise. Default
 *     preset is mobile (Moto G Power simulation) — the audit's
 *     stated target.
 */
module.exports = {
	ci: {
		collect: {
			// `vite preview` defaults to 4173. Pin explicitly so a port
			// change in the SvelteKit defaults doesn't quietly break CI.
			startServerCommand: 'pnpm preview --port 4173 --host 127.0.0.1',
			startServerReadyPattern: 'Local:',
			url: ['http://127.0.0.1:4173/'],
			numberOfRuns: 3,
			settings: {
				// Block the live-demo image (`/c/crypto-lp-card/...`).
				// That endpoint queries Postgres for the canvas record,
				// and the LHCI workflow runs without a seeded DB — the
				// page would otherwise audit with a real network 404
				// docked against the Best Practices score (Codex round 1
				// P1). With the URL blocked, the landing falls back to
				// its `imageFailed` state — designed copy ("Live preview
				// unavailable"), no broken request in the report. The
				// guardrail still catches regressions in the chrome
				// around the demo, which is what TASK-138 actually
				// changed. Once the workflow grows a seed harness for
				// the published canvas (tracked as a follow-up), drop
				// this block so we audit the realistic UX.
				blockedUrlPatterns: ['*/c/crypto-lp-card/*']
				// Lighthouse's default form-factor is mobile (Moto G
				// Power, 4G throttling, 360x640 viewport) — exactly
				// what TASK-138/139 were tuned for. No `formFactor`
				// override; piecemeal overrides lead to inconsistent
				// runs.
			}
		},
		assert: {
			assertions: {
				// Performance floor. 0.80 reflects the post-TASK-138 baseline
				// with some headroom for noisy single-runs. Worth tightening
				// to 0.90 after a few weeks of stable green runs.
				'categories:performance': ['error', { minScore: 0.8 }],
				// A11y floor. Set high — the TASK-115 family of work
				// (skip-link, focus-trap, focus-visible, axe smoke) should
				// keep us at or above 0.95. Pegged at 0.90 so a non-blocking
				// regression doesn't tank a PR before triage.
				'categories:accessibility': ['error', { minScore: 0.9 }],
				// Best practices — covers things like console errors, HTTPS,
				// image aspect-ratio, no document.write. Floor at 0.90.
				'categories:best-practices': ['error', { minScore: 0.9 }],
				// SEO — landing page is the primary SEO target. Floor at
				// 0.90 because we already emit the right meta tags.
				'categories:seo': ['error', { minScore: 0.9 }],
				// PWA category is excluded — we're not pursuing a service
				// worker / manifest story on PLAN-84, and a 0-score there
				// would dominate the report visually without informing
				// product decisions.
				'categories:pwa': 'off'
			}
		},
		upload: {
			// Temporary public storage so CI artifacts have a viewable
			// link without needing a paid LHCI server / S3 bucket. Each
			// upload returns a URL that lives ~7 days. Sufficient for
			// PR review; bump to `lhci-server` if the team starts
			// caring about historical trends.
			target: 'temporary-public-storage'
		}
	}
};
