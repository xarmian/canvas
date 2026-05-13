<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';

	/**
	 * Shared public-share landing page used by both `/c/{slug}` (live
	 * template-resolved render) and `/i/{shortId}` (baked render). The
	 * markup, OG-meta block, and Continue-to interstitial CTA are
	 * identical across the two surfaces by design — IDEA-161 Q7 picks
	 * the same UX for v1 so crawler fixtures + accessibility audits
	 * apply to both. A future paid-tier auto-302 mode (IDEA-162) would
	 * be a separate variant.
	 */
	interface Props {
		imageUrl: string;
		canonicalShareUrl: string;
		ogTitle: string;
		ogDescription: string;
		width: number;
		height: number;
		/** Post-substitution, http(s)-validated. `null` suppresses the CTA. */
		redirectUrl: string | null;
	}

	const { imageUrl, canonicalShareUrl, ogTitle, ogDescription, width, height, redirectUrl }: Props =
		$props();

	/** Friendly label for the Continue CTA — show the destination host
	 *  rather than the full URL. Full URLs on a mobile button truncate
	 *  awkwardly and obscure trust signals. The host is what users scan
	 *  for ("am I going to twitter.com or twiter.com?"). The underlying
	 *  anchor still navigates to the full substituted URL, so query
	 *  params + paths are preserved. */
	const redirectHost = $derived.by(() => {
		if (!redirectUrl) return null;
		try {
			return new URL(redirectUrl).host;
		} catch {
			// Fall back to the raw URL if it failed to parse — shouldn't
			// happen because the publish form validates URLs, but the
			// {{param}} substitution path could in theory produce one.
			return redirectUrl;
		}
	});
</script>

<svelte:head>
	<!-- OG Meta Tags -->
	<title>{ogTitle}</title>
	<meta property="og:title" content={ogTitle} />
	<meta property="og:description" content={ogDescription} />
	<meta property="og:image" content={imageUrl} />
	<meta property="og:image:width" content={String(width)} />
	<meta property="og:image:height" content={String(height)} />
	<!-- og:image:type: required by some crawlers (LinkedIn, older Slack) to
	     skip the binary-sniff step. The share page emits a PNG image URL
	     for /c/{slug}; for /i/{shortId} the image URL extension may be
	     png/jpg/webp/avif. We keep the type hint as `image/png` because
	     most crawlers prefer PNG for OG and the baked-render flow already
	     defaults to PNG; alternate formats are integrator-driven and the
	     type field is advisory. -->
	<meta property="og:image:type" content="image/png" />
	{#if imageUrl.startsWith('https://')}
		<!-- og:image:secure_url is the same value when the public app URL
		     is https. Crawlers prefer this on https pages and omitting it
		     can cause inline-card downgrades. -->
		<meta property="og:image:secure_url" content={imageUrl} />
	{/if}
	<meta property="og:url" content={canonicalShareUrl} />
	<meta property="og:type" content="website" />

	<!-- Twitter Card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={ogTitle} />
	<meta name="twitter:description" content={ogDescription} />
	<meta name="twitter:image" content={imageUrl} />

	<meta name="description" content={ogDescription} />
</svelte:head>

<div class="landing">
	<div class="card">
		<img
			src={imageUrl}
			alt={ogTitle}
			class="preview"
			{width}
			{height}
			loading="eager"
			decoding="async"
		/>
		<div class="body">
			<h1>{ogTitle}</h1>
			<p class="description">{ogDescription}</p>

			{#if redirectUrl && redirectHost}
				<a
					href={redirectUrl}
					class="continue"
					rel="noopener"
					aria-label="Continue to {redirectHost}"
				>
					<span>Continue to {redirectHost}</span>
					<ArrowRight size={18} aria-hidden="true" />
				</a>
			{/if}

			<p class="meta">
				{width} × {height} · Created with <a href="/" class="brand">Canvas</a>
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
		overflow-wrap: anywhere;
	}

	.description {
		margin: 0 0 var(--spacing-4);
		font-size: var(--text-md);
		color: var(--color-text-muted);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

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

	.brand {
		color: var(--color-primary);
		text-decoration: underline;
	}

	.brand:hover {
		text-decoration: underline;
	}

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
			width: auto;
			min-width: 14rem;
		}
	}
</style>
