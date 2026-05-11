<script lang="ts">
	/**
	 * Public landing page (TASK-99 / PLAN-82).
	 *
	 * The 60-second answer to "what is Canvas?" — replaces the old unauth
	 * redirect to /login with a real pitch surface that demonstrates the
	 * product in front of the visitor.
	 *
	 * Hero strategy: the headline isn't a paragraph, it's a *demo*. A small
	 * param panel drives a live `/c/crypto-lp-card/image.png` render — the
	 * same render path social-card crawlers fetch — so the visitor sees the
	 * dynamic-image story *while* they tinker. The image URL the form
	 * builds is the same shape any user would paste into a tweet.
	 *
	 * Authenticated visitors are redirected to /dashboard server-side via
	 * +page.server.ts; this component only renders for unauth visitors.
	 *
	 * `/c/crypto-lp-card` is the canonical demo slug. Reserved in
	 * `src/lib/server/slug.ts` (`RESERVED_SLUGS`) so a user-claimed
	 * canvas cannot hijack or 404 the public hero — both `validateSlug`
	 * (rename) and `findAvailableSlug` (auto-derive) treat it as
	 * already-taken. Because reservation also blocks the operator's
	 * "Use this template" → publish flow from landing on this slug,
	 * the demo canvas must be seeded by a direct DB insert (see the
	 * Human-Tasks runbook spawned for PLAN-82). On a fresh self-host
	 * before the seed lands, `<img onerror>` swaps the hero to a
	 * "preview unavailable" state so the page still looks intentional.
	 *
	 * No public Gallery link: `/templates` is still inside the (app)
	 * group and auth-gated, so a public-facing "Browse the gallery" link
	 * just bounces visitors through `/login`. We surface a single
	 * Sign-up CTA as the funnel and defer a public template gallery to
	 * its own task (gallery + "Use this template" both need an
	 * unauthenticated entry point that drops users at `/signup` with
	 * intent — out of scope for the landing-page slice).
	 */

	const GITHUB_URL = 'https://github.com/xarmian/canvas';

	// Demo state — small, focused param set the visitor can tinker with.
	// Mirrors the binding names in src/lib/templates/gallery.ts so the URL
	// the form builds is the same one a real user would publish.
	let tokenA = $state('USDC');
	let tokenB = $state('ETH');
	// gainPercent is fractional in the renderer (signed-percent formatter
	// multiplies by 100). 0.125 → "+12.50%". The slider lets the visitor
	// flip negative → red gain text + red P/L without typing.
	let gainPercent = $state(0.125);
	let range = $state<'in_range' | 'edge' | 'out_of_range'>('in_range');
	let boosted = $state(true);

	/**
	 * Small set of token-symbol → logo data URLs. The crypto-lp-card
	 * template's `Image` layers fall back to a gray-circle-with-?
	 * placeholder when no `tokenALogoUrl` / `tokenBLogoUrl` is supplied
	 * (TASK-118). For the headline demo tokens we ship a real-looking
	 * mark so first-time visitors don't see two question marks.
	 *
	 * Inlined as data URLs rather than `/static/...` paths because the
	 * renderer's SSRF guard (`isUrlSafe` in src/lib/engine/images.ts)
	 * rejects every non-http(s) URL, and an http URL pointing at
	 * `localhost` is blocked too — so a relative path can't survive the
	 * round-trip through the public render endpoint. Data URLs skip the
	 * fetch path entirely via the inline decoder.
	 *
	 * Each glyph is ~250 bytes URL-encoded, so the demo URL grows
	 * modestly even with both logos set. Visitors don't share the demo
	 * URL itself (it's not the canonical share URL), so the bloat is
	 * cosmetic at worst.
	 */
	const TOKEN_LOGOS: Record<string, string> = {
		USDC:
			'data:image/svg+xml;utf8,' +
			encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#2775ca"/><text x="32" y="42" font-size="28" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#ffffff">$</text></svg>'
			),
		ETH:
			'data:image/svg+xml;utf8,' +
			encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#627eea"/><text x="32" y="42" font-size="28" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#ffffff">Ξ</text></svg>'
			)
	};

	/** Case-insensitive lookup so a visitor typing `eth` still gets the
	 *  matched logo. Returns null when the symbol isn't in the table —
	 *  the template's GENERIC_TOKEN_FALLBACK (gray circle + ?) renders
	 *  in that case, which is intentional signalling rather than a
	 *  broken-looking missing asset. */
	function logoFor(symbol: string): string | null {
		return TOKEN_LOGOS[symbol.toUpperCase()] ?? null;
	}

	/** Build the live image URL from the demo state. Reactivity flows
	 *  state → derived URL → <img src>; changing any input refetches the
	 *  image, which is exactly the production code path.
	 *
	 *  Param object is built as a plain record first, then handed to
	 *  URLSearchParams in one shot — the `svelte/prefer-svelte-reactivity`
	 *  lint rule flags mutable URLSearchParams usage, and we don't need
	 *  the reactive variant here because the whole $derived recomputes
	 *  on state change anyway. */
	let imageUrl = $derived.by(() => {
		const fields: Record<string, string> = {
			tokenA,
			tokenB,
			gainPercent: gainPercent.toFixed(3),
			range,
			rangeLabel:
				range === 'in_range' ? 'In Range' : range === 'edge' ? 'Near Edge' : 'Out of Range',
			boosted: boosted ? 'true' : 'false',
			// Include a few sane defaults so the preview reads like a real
			// position even though the form only exposes the headline knobs.
			pl: (gainPercent * 1000).toFixed(2),
			entry: '0.10',
			mark: (0.1 * (1 + gainPercent)).toFixed(4),
			volume: '1234567',
			timeframe: '24h'
		};
		// Set the logo URLs only when we have a match — leaving them
		// absent lets the template's static placeholder render unchanged
		// for unknown symbols. Setting them to '' would override the
		// placeholder with an empty src and produce a broken image.
		const aLogo = logoFor(tokenA);
		if (aLogo) fields.tokenALogoUrl = aLogo;
		const bLogo = logoFor(tokenB);
		if (bLogo) fields.tokenBLogoUrl = bLogo;
		return `/c/crypto-lp-card/image.png?${new URLSearchParams(fields).toString()}`;
	});

	/** Pretty-print the URL for the "this is what you'd tweet" copy. We
	 *  show the share path (no `/image.png`) since that's what humans paste
	 *  into a tweet — Twitter's crawler hits the og:image link from there. */
	let shareUrl = $derived.by(() => imageUrl.replace('/image.png', ''));

	let imageFailed = $state(false);
	function onImageError() {
		imageFailed = true;
	}
	function onImageLoad() {
		imageFailed = false;
	}

	function formatGainLabel(g: number): string {
		const sign = g >= 0 ? '+' : '';
		return `${sign}${(g * 100).toFixed(1)}%`;
	}
</script>

<svelte:head>
	<title>Canvas — design dynamic images, share by URL</title>
	<meta
		name="description"
		content="Canvas turns visual templates into shareable URLs. Design once, generate infinite variants by passing dynamic values. Open source and self-hostable."
	/>
</svelte:head>

<div class="page">
	<header class="topbar">
		<a href="/" class="brand" aria-label="Canvas home">Canvas</a>
		<nav class="topnav" aria-label="Primary">
			<a href={GITHUB_URL} rel="noopener" class="topnav-link">GitHub</a>
			<a href="/login" class="topnav-link">Log in</a>
			<a href="/signup" class="topnav-cta">Sign up</a>
		</nav>
	</header>

	<main>
		<section class="hero">
			<div class="hero-copy">
				<h1>
					Tweet a <span class="accent">dynamic image</span>.
				</h1>
				<p class="lede">
					Design a template once. Change the URL, change the image. Every social card, OG preview,
					or embed becomes a dynamic URL you can share anywhere.
				</p>
				<div class="hero-ctas">
					<a href="/signup" class="btn btn-primary" data-testid="hero-signup">Start designing</a>
					<a href={GITHUB_URL} rel="noopener" class="btn btn-secondary">View on GitHub</a>
				</div>
				<p class="hero-tip">No credit card. Open source. Self-hostable.</p>
			</div>

			<div class="demo">
				<div class="demo-label">Live demo — try the controls</div>
				<div class="demo-frame" class:demo-failed={imageFailed}>
					{#if imageFailed}
						<div class="demo-fallback">
							<strong>Live preview unavailable</strong>
							<span>Publish the crypto-lp-card template to enable the on-page demo.</span>
						</div>
					{:else}
						<img
							src={imageUrl}
							alt="Live-rendered crypto LP-card preview reflecting the demo controls"
							class="demo-image"
							loading="eager"
							decoding="async"
							onerror={onImageError}
							onload={onImageLoad}
							data-testid="hero-demo-image"
						/>
					{/if}
				</div>

				<div class="demo-controls" role="group" aria-label="Demo controls">
					<label class="ctrl">
						<span>Token A</span>
						<input
							type="text"
							bind:value={tokenA}
							maxlength="6"
							autocomplete="off"
							spellcheck="false"
							data-testid="demo-tokenA"
						/>
					</label>
					<label class="ctrl">
						<span>Token B</span>
						<input
							type="text"
							bind:value={tokenB}
							maxlength="6"
							autocomplete="off"
							spellcheck="false"
							data-testid="demo-tokenB"
						/>
					</label>
					<label class="ctrl ctrl-wide">
						<span>Gain {formatGainLabel(gainPercent)}</span>
						<input
							type="range"
							min="-0.5"
							max="0.5"
							step="0.005"
							bind:value={gainPercent}
							data-testid="demo-gain"
						/>
					</label>
					<label class="ctrl">
						<span>Range</span>
						<select bind:value={range} data-testid="demo-range">
							<option value="in_range">In range</option>
							<option value="edge">Near edge</option>
							<option value="out_of_range">Out of range</option>
						</select>
					</label>
					<label class="ctrl ctrl-checkbox">
						<input type="checkbox" bind:checked={boosted} data-testid="demo-boosted" />
						<span>Boosted</span>
					</label>
				</div>

				<div class="demo-url" aria-live="polite">
					<span class="demo-url-label">Share URL</span>
					<code class="demo-url-value" data-testid="demo-share-url">{shareUrl}</code>
				</div>
			</div>
		</section>

		<section class="tweet-section" aria-label="Tweet preview">
			<h2>This is what your followers see.</h2>
			<p class="tweet-section-lede">
				Drop the share URL into a tweet. Twitter, LinkedIn, Slack, and Discord crawl the link,
				render the image with whatever values you passed, and show it inline.
			</p>

			<div class="tweet-card" data-testid="tweet-mockup">
				<div class="tweet-head">
					<div class="tweet-avatar" aria-hidden="true">D</div>
					<div class="tweet-who">
						<div class="tweet-name">Designer</div>
						<div class="tweet-handle">@designer · 2m</div>
					</div>
				</div>
				<p class="tweet-body">
					Live position update — {tokenA}/{tokenB} pool, {formatGainLabel(gainPercent)} so far.
				</p>
				<a class="tweet-og" href={shareUrl} rel="noopener" aria-label="Open the dynamic share URL">
					<div class="tweet-og-image-wrap">
						{#if imageFailed}
							<div class="tweet-og-fallback">Dynamic preview</div>
						{:else}
							<img src={imageUrl} alt="" class="tweet-og-image" loading="lazy" decoding="async" />
						{/if}
					</div>
					<div class="tweet-og-meta">
						<div class="tweet-og-domain">canvas.example</div>
						<div class="tweet-og-title">{tokenA}/{tokenB} LP — {formatGainLabel(gainPercent)}</div>
					</div>
				</a>
			</div>
		</section>

		<section class="steps" aria-label="How it works">
			<h2>How it works</h2>
			<ol class="steps-list">
				<li>
					<div class="step-num">1</div>
					<h3>Design</h3>
					<p>
						Lay out text, images, and shapes in the visual editor. Snap, layer, undo — the usual.
					</p>
				</li>
				<li>
					<div class="step-num">2</div>
					<h3>Bind</h3>
					<p>
						Mark any property as dynamic and give the URL value a name. That name becomes a knob
						anyone can turn at request time.
					</p>
				</li>
				<li>
					<div class="step-num">3</div>
					<h3>Tweet</h3>
					<p>
						Publish, copy the share URL, paste it anywhere. The image renders fresh on every visit.
					</p>
				</li>
			</ol>
		</section>
	</main>

	<footer class="footer">
		<span>Canvas is open source.</span>
		<a href={GITHUB_URL} rel="noopener">View on GitHub</a>
		<span aria-hidden="true">·</span>
		<a href="/signup">Sign up</a>
		<span aria-hidden="true">·</span>
		<a href="/login">Log in</a>
	</footer>
</div>

<style>
	.page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		background: linear-gradient(180deg, #f8fafc 0%, #fff 35%);
		color: #0f172a;
		font-family:
			system-ui,
			-apple-system,
			Segoe UI,
			Roboto,
			Helvetica,
			Arial,
			sans-serif;
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		/* Mobile: 1rem horizontal padding gives the brand + 3-item nav
		   ~343px of usable width at a 375px viewport — fits comfortably
		   without horizontal scroll. The desktop 1.5rem reads better
		   on wider viewports and is restored below the breakpoint. */
		padding: 0.85rem 1rem;
		max-width: 1180px;
		margin: 0 auto;
		width: 100%;
		box-sizing: border-box;
	}

	.brand {
		font-weight: 700;
		font-size: 1.25rem;
		text-decoration: none;
		color: #0f172a;
		letter-spacing: -0.01em;
	}

	.topnav {
		display: flex;
		align-items: center;
		/* Mobile-first: tight gap keeps the 3-item nav from wrapping at
		   375px. Restored to 1rem at lg via the breakpoint block. */
		gap: 0.6rem;
	}

	.topnav-link {
		display: inline-flex;
		align-items: center;
		/* min-height: 44px ensures the tap target hits Apple HIG's
		   minimum on mobile even though the visible text is small.
		   Padding stays small so desktop reads as a nav link, not
		   a button — the height is reached via min-height alone. */
		min-height: 44px;
		padding: 0 0.25rem;
		color: #475569;
		text-decoration: none;
		/* Mobile-first: 0.85rem keeps 3 nav items + the brand on one
		   row at 375px. Restored to 0.9rem at lg. */
		font-size: 0.85rem;
		font-weight: 500;
	}

	.topnav-link:hover {
		color: #0f172a;
	}

	.topnav-cta {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.5rem 1rem;
		background: #0f172a;
		color: #fff;
		border-radius: 6px;
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 600;
	}

	main {
		flex: 1;
		max-width: 1180px;
		margin: 0 auto;
		width: 100%;
		/* 1rem horizontal padding leaves 343px of usable width at a
		   375px viewport — comfortable for the demo controls and
		   tweet card without horizontal scroll. Desktop pads to
		   1.5rem via the breakpoint below for visual balance. */
		padding: 0 1rem;
		box-sizing: border-box;
	}

	.hero {
		display: grid;
		/* Mobile-first: single column stacks copy above the demo
		   panel. Splits into the side-by-side 2-column layout at
		   ≥880px (see the breakpoint block below). */
		grid-template-columns: minmax(0, 1fr);
		gap: 2rem;
		align-items: center;
		padding: 2rem 0 3rem;
	}

	.hero-copy h1 {
		margin: 0 0 1rem;
		font-size: clamp(2rem, 4.5vw, 3rem);
		line-height: 1.1;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	.accent {
		background: linear-gradient(90deg, #14b8a6, #2563eb);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}

	.lede {
		margin: 0 0 1.75rem;
		font-size: 1.05rem;
		line-height: 1.55;
		color: #334155;
		max-width: 36rem;
	}

	.hero-ctas {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.hero-tip {
		margin: 0.9rem 0 0;
		color: #64748b;
		font-size: 0.85rem;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* TASK-138 acceptance: all landing CTAs hit a 44px touch
		   target on mobile. The old padding produced a ~38px button
		   — usable on desktop, sub-Apple-HIG on a phone. min-height
		   keeps the visual proportions stable across viewports
		   while guaranteeing the target. */
		min-height: 44px;
		padding: 0.75rem 1.25rem;
		border-radius: 7px;
		font-size: 0.95rem;
		font-weight: 600;
		text-decoration: none;
		border: none;
		cursor: pointer;
	}

	.btn-primary {
		background: #0f172a;
		color: #fff;
	}

	.btn-primary:hover {
		background: #1e293b;
	}

	.btn-secondary {
		background: #fff;
		color: #0f172a;
		border: 1px solid #cbd5e1;
	}

	.btn-secondary:hover {
		background: #f1f5f9;
	}

	.demo {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		min-width: 0;
	}

	.demo-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #14b8a6;
	}

	.demo-frame {
		background: #0f172a;
		border-radius: 12px;
		overflow: hidden;
		aspect-ratio: 1200 / 630;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow:
			0 1px 2px rgba(15, 23, 42, 0.06),
			0 16px 40px -16px rgba(15, 23, 42, 0.4);
	}

	.demo-image {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}

	.demo-fallback {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		text-align: center;
		color: #cbd5e1;
		padding: 1.5rem;
	}

	.demo-fallback strong {
		color: #fff;
		font-size: 1rem;
	}

	.demo-fallback span {
		font-size: 0.85rem;
		color: #94a3b8;
	}

	/* Mobile-first per TASK-138: at narrow viewports two text inputs
	   side-by-side leave ~120px each, too cramped for 6-char ticker
	   symbols + label. Single-column on mobile gives each control
	   full breathing room; the 2-col layout kicks in at 768px+
	   where horizontal space stops being precious. */
	.demo-controls {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.65rem;
	}

	.ctrl {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
		color: #475569;
	}

	.ctrl > span {
		font-weight: 600;
	}

	.ctrl input[type='text'],
	.ctrl select {
		/* min-height: 44px so demo inputs are tappable on mobile —
		   the audit's CTA touch-target rule applies to interactive
		   controls too, not just buttons. */
		min-height: 44px;
		padding: 0.55rem 0.65rem;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		font-size: 0.875rem;
		background: #fff;
		color: #0f172a;
	}

	.ctrl input[type='text']:focus,
	.ctrl select:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
	}

	.ctrl input[type='range'] {
		width: 100%;
	}

	/* On mobile (single-column grid) the wide-spanning controls just
	   take the only column. Their span-2 layout matters at md+ where
	   the grid splits into two columns — see the media query below. */
	.ctrl-wide {
		grid-column: span 1;
	}

	.ctrl-checkbox {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		grid-column: span 1;
	}

	.ctrl-checkbox > span {
		font-weight: 600;
	}

	.ctrl-checkbox input[type='checkbox'] {
		/* Bigger hit area for the checkbox — the visible square stays
		   the browser default but the click region expands. */
		width: 1.15rem;
		height: 1.15rem;
	}

	.demo-url {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.65rem 0.8rem;
		background: #f8fafc;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		min-width: 0;
	}

	.demo-url-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 600;
		color: #64748b;
	}

	.demo-url-value {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
		color: #0f172a;
		word-break: break-all;
	}

	.tweet-section {
		padding: 3rem 0 4rem;
		text-align: center;
	}

	.tweet-section h2 {
		margin: 0 0 0.5rem;
		font-size: 1.7rem;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.tweet-section-lede {
		margin: 0 auto 2rem;
		max-width: 36rem;
		color: #475569;
		font-size: 1rem;
		line-height: 1.55;
	}

	.tweet-card {
		max-width: 520px;
		margin: 0 auto;
		text-align: left;
		background: #fff;
		border: 1px solid #e2e8f0;
		border-radius: 14px;
		padding: 1rem 1.1rem;
		box-shadow:
			0 1px 2px rgba(15, 23, 42, 0.04),
			0 16px 40px -20px rgba(15, 23, 42, 0.25);
	}

	.tweet-head {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		margin-bottom: 0.5rem;
	}

	.tweet-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: linear-gradient(135deg, #14b8a6, #2563eb);
		color: #fff;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
	}

	.tweet-name {
		font-weight: 700;
		color: #0f172a;
		font-size: 0.9rem;
	}

	.tweet-handle {
		color: #64748b;
		font-size: 0.8rem;
	}

	.tweet-body {
		margin: 0 0 0.65rem;
		color: #0f172a;
		font-size: 0.95rem;
		line-height: 1.45;
	}

	.tweet-og {
		display: block;
		text-decoration: none;
		color: inherit;
		border: 1px solid #cbd5e1;
		border-radius: 12px;
		overflow: hidden;
		background: #fff;
	}

	.tweet-og:hover {
		border-color: #94a3b8;
	}

	.tweet-og-image-wrap {
		aspect-ratio: 1200 / 630;
		background: #0f172a;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.tweet-og-image {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}

	.tweet-og-fallback {
		color: #94a3b8;
		font-size: 0.85rem;
	}

	.tweet-og-meta {
		padding: 0.6rem 0.8rem;
		border-top: 1px solid #e2e8f0;
	}

	.tweet-og-domain {
		font-size: 0.75rem;
		color: #64748b;
	}

	.tweet-og-title {
		font-weight: 600;
		font-size: 0.9rem;
		color: #0f172a;
	}

	.steps {
		padding: 1rem 0 4rem;
	}

	.steps h2 {
		text-align: center;
		font-size: 1.7rem;
		font-weight: 700;
		margin: 0 0 2rem;
		letter-spacing: -0.01em;
	}

	.steps-list {
		display: grid;
		/* Mobile-first: stack the three steps vertically at narrow
		   viewports — 3-up only kicks in at ≥880px where each card
		   gets enough width to keep its copy on 2–3 lines. */
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.steps-list li {
		background: #fff;
		border: 1px solid #e2e8f0;
		border-radius: 12px;
		padding: 1.25rem;
	}

	.step-num {
		width: 32px;
		height: 32px;
		border-radius: 8px;
		background: #0f172a;
		color: #fff;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		margin-bottom: 0.6rem;
	}

	.steps-list h3 {
		margin: 0 0 0.4rem;
		font-size: 1.05rem;
		font-weight: 700;
	}

	.steps-list p {
		margin: 0;
		color: #475569;
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.footer {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 0.5rem;
		padding: 1.5rem;
		color: #64748b;
		font-size: 0.85rem;
		border-top: 1px solid #e2e8f0;
		margin-top: auto;
	}

	.footer a {
		color: #2563eb;
		text-decoration: none;
	}

	.footer a:hover {
		text-decoration: underline;
	}

	/*
	 * Mobile-first responsive rules. The base CSS above targets the
	 * narrowest viewport (375px reference); these media queries layer
	 * in the wider-viewport refinements as space allows.
	 *
	 *   sm  ≥ 640px  — restore the loose horizontal padding on main /
	 *                   topbar and let secondary surfaces breathe.
	 *   md  ≥ 768px  — split demo-controls into the 2-column layout;
	 *                   restore .ctrl-wide / .ctrl-checkbox span-2.
	 *   lg  ≥ 880px  — hero splits to copy + demo side-by-side; steps
	 *                   grid splits into 3 columns.
	 *
	 * The 880px hero breakpoint preserves the existing visual target
	 * (the demo column needs ~520px before it stops feeling cramped
	 * next to the copy). 768px and 640px match Tailwind's md/sm tokens
	 * so future work that does adopt utility classes lines up cleanly.
	 */

	@media (min-width: 640px) {
		.topbar {
			padding: 1rem 1.5rem;
		}
		main {
			padding: 0 1.5rem;
		}
	}

	@media (min-width: 768px) {
		.demo-controls {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.ctrl-wide,
		.ctrl-checkbox {
			grid-column: span 2;
		}
	}

	@media (min-width: 880px) {
		.hero {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
			gap: 3rem;
			padding: 3rem 0 4rem;
		}
		.steps-list {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.topnav {
			gap: 1rem;
		}
		.topnav-link {
			font-size: 0.9rem;
		}
	}
</style>
