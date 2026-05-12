<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';

	let { data } = $props();

	/** Friendly label for the Continue CTA — show the destination host
	 *  rather than the full URL. Full URLs on a mobile button truncate
	 *  awkwardly and obscure trust signals. The host is what users
	 *  scan for ("am I going to twitter.com or twiter.com?"). The
	 *  underlying anchor still navigates to the full substituted URL,
	 *  so query params + paths are preserved. */
	const redirectHost = $derived.by(() => {
		if (!data.redirectUrl) return null;
		try {
			return new URL(data.redirectUrl).host;
		} catch {
			// Fall back to the raw URL if it failed to parse — shouldn't
			// happen because the publish form validates URLs, but the
			// {{param}} substitution path could in theory produce one.
			return data.redirectUrl;
		}
	});
</script>

<svelte:head>
	<!-- OG Meta Tags (TASK-97) -->
	<title>{data.ogTitle}</title>
	<meta property="og:title" content={data.ogTitle} />
	<meta property="og:description" content={data.ogDescription} />
	<meta property="og:image" content={data.imageUrl} />
	<meta property="og:image:width" content={String(data.canvas.width)} />
	<meta property="og:image:height" content={String(data.canvas.height)} />
	<!-- og:image:type: required by some crawlers (LinkedIn, older Slack)
	     to skip the binary-sniff step. The share page always emits a
	     PNG image URL — JPEG/WebP/AVIF are alternate render formats
	     consumers can request explicitly via the file extension, but
	     the social-card path is hard-coded to PNG. -->
	<meta property="og:image:type" content="image/png" />
	{#if data.imageUrl.startsWith('https://')}
		<!-- og:image:secure_url is the same value when the public app
		     URL is https. Crawlers prefer this on https pages and
		     omitting it can cause inline-card downgrades. We emit it
		     conditionally so localhost dev (http) doesn't put a bogus
		     https URL in the head. -->
		<meta property="og:image:secure_url" content={data.imageUrl} />
	{/if}
	<meta property="og:url" content={data.canonicalShareUrl} />
	<meta property="og:type" content="website" />

	<!-- Twitter Card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={data.ogTitle} />
	<meta name="twitter:description" content={data.ogDescription} />
	<meta name="twitter:image" content={data.imageUrl} />

	<meta name="description" content={data.ogDescription} />
</svelte:head>

<!--
	Public landing page for `/c/{slug}`. Two shapes:

	  – No redirect configured → preview card + "Created with Canvas"
	    footer. This is the social-share interstitial that bots scrape
	    for OG meta and humans see when they tap the link from Twitter
	    or similar.

	  – Redirect configured → same card + prominent "Continue to {host}"
	    CTA. Replaces the previous server-side 302 (see +page.server.ts
	    for rationale). The CTA is a plain anchor so middle-click /
	    long-press "Open in new tab" / right-click semantics all work,
	    and so screen readers announce it as a link, not a button.

	The layout is mobile-first: 1rem of padding at small viewports
	(audit flagged 2rem as too aggressive at 375px wide — left ~85px
	usable). Larger viewports get more breathing room. Tokens come
	from app.css so the page matches the rest of the product.
-->
<div class="landing">
	<div class="card">
		<img
			src={data.imageUrl}
			alt={data.ogTitle}
			class="preview"
			width={data.canvas.width}
			height={data.canvas.height}
			loading="eager"
			decoding="async"
		/>
		<div class="body">
			<h1>{data.ogTitle}</h1>
			<p class="description">{data.ogDescription}</p>

			{#if data.redirectUrl && redirectHost}
				<a
					href={data.redirectUrl}
					class="continue"
					rel="noopener"
					aria-label="Continue to {redirectHost}"
				>
					<span>Continue to {redirectHost}</span>
					<ArrowRight size={18} aria-hidden="true" />
				</a>
			{/if}

			<p class="meta">
				{data.canvas.width} × {data.canvas.height} · Created with
				<a href="/" class="brand">Canvas</a>
			</p>
		</div>
	</div>
</div>

<style>
	.landing {
		display: flex;
		justify-content: center;
		align-items: flex-start;
		min-height: 100vh;
		background: var(--color-surface);
		padding: var(--spacing-4);
	}

	.card {
		background: var(--color-bg);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-lg);
		max-width: 640px;
		width: 100%;
		overflow: hidden;
		margin-block: var(--spacing-6) var(--spacing-8);
	}

	.preview {
		width: 100%;
		height: auto;
		display: block;
		/* Keep the image from blowing past the canvas's intrinsic
		   ratio when the viewport is wider than the canvas itself. */
		background: var(--color-surface-muted);
	}

	.body {
		padding: var(--spacing-6) var(--spacing-4) var(--spacing-4);
		text-align: center;
	}

	h1 {
		margin: 0 0 var(--spacing-2);
		font-size: var(--text-xl);
		font-weight: 600;
		color: var(--color-text);
		line-height: 1.3;
		/* Long titles on narrow viewports — wrap aggressively rather
		   than horizontally scrolling. */
		overflow-wrap: anywhere;
	}

	.description {
		margin: 0 0 var(--spacing-4);
		font-size: var(--text-md);
		color: var(--color-text-muted);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	/* Continue-to CTA. Sized for thumb reach: min 44px tall (Apple HIG
	   minimum touch target). Full-width on mobile so the entire CTA
	   row is tappable without precision aim. */
	.continue {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--spacing-2);
		width: 100%;
		min-height: 44px;
		padding: var(--spacing-3) var(--spacing-4);
		margin-block: var(--spacing-2) var(--spacing-4);
		background: var(--color-primary);
		color: var(--color-bg);
		font-size: var(--text-md);
		font-weight: 600;
		text-decoration: none;
		border-radius: var(--radius-md);
		transition:
			background 0.15s ease,
			transform 0.05s ease;
		/* Long redirect hosts (e.g. ".onion" addresses, IP literals)
		   should ellipsize rather than overflow. */
		overflow: hidden;
	}

	.continue span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.continue:hover {
		background: var(--color-primary-hover);
	}

	.continue:active {
		transform: translateY(1px);
	}

	.continue:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.meta {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--color-text-subtle);
	}

	/*
	 * BT-159: the "Created with [Canvas]" link sits inline inside a
	 * `<p class="meta">`. Link-in-text-block (WCAG SC 1.4.1) requires
	 * a non-color differentiator since the primary-blue link vs the
	 * `--color-text-subtle` paragraph color fails the 3:1 contrast
	 * floor for color-alone differentiation. Pre-BT-159 this was
	 * `text-decoration: none` with underline only on hover — now
	 * underlined by default. Hover rule is kept as a no-op for
	 * safety against future Tailwind preflight changes.
	 */
	.brand {
		color: var(--color-primary);
		text-decoration: underline;
	}

	.brand:hover {
		text-decoration: underline;
	}

	/* Wider viewports — restore breathing room. */
	@media (min-width: 640px) {
		.landing {
			padding: var(--spacing-8);
		}

		.body {
			padding: var(--spacing-6);
		}

		h1 {
			font-size: var(--text-2xl);
		}

		.continue {
			/* On larger screens an inline-auto-width button reads less
			   like a primary action banner and more like a CTA chip. */
			width: auto;
			min-width: 14rem;
		}
	}
</style>
