<script lang="ts">
	/**
	 * Three external links that open the major social platforms' OG-preview
	 * tools with the share URL pre-filled. Used inside PublishModal as the
	 * "Test on social" section.
	 *
	 * Pure markup — no state, no fetches. Extracted from PublishModal as the
	 * first step of the modal decomposition (PLAN-232, TASK-233).
	 */
	interface Props {
		shareUrl: string;
	}

	let { shareUrl }: Props = $props();
</script>

<section class="validator-section" data-testid="validator-section">
	<h3 class="validator-title">Test on social</h3>
	<p class="validator-hint">
		Open the share URL in each platform's preview tool to refresh the cache and confirm the card
		renders. Each link opens in a new tab with the URL pre-filled.
	</p>
	<div class="validator-row">
		<a
			class="btn btn-secondary"
			data-testid="validator-twitter"
			href="https://cards-dev.twitter.com/validator?url={encodeURIComponent(shareUrl)}"
			target="_blank"
			rel="noopener noreferrer"
			title="Force Twitter / X to re-fetch the OG card and show validation issues"
		>
			Twitter Card Validator
		</a>
		<a
			class="btn btn-secondary"
			data-testid="validator-facebook"
			href="https://developers.facebook.com/tools/debug/?q={encodeURIComponent(shareUrl)}"
			target="_blank"
			rel="noopener noreferrer"
			title="Facebook / Meta sharing debugger — also flushes WhatsApp / Instagram caches"
		>
			Facebook Debugger
		</a>
		<a
			class="btn btn-secondary"
			data-testid="validator-linkedin"
			href="https://www.linkedin.com/post-inspector/inspect/{encodeURIComponent(shareUrl)}"
			target="_blank"
			rel="noopener noreferrer"
			title="LinkedIn Post Inspector — re-fetches and shows the rendered card"
		>
			LinkedIn Post Inspector
		</a>
	</div>
</section>

<style>
	.validator-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.validator-title {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.validator-hint {
		margin: 0 0 0.6rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		line-height: 1.5;
	}

	.validator-row {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	/*
	 * Anchor-as-button styles duplicated from PublishModal. The parent
	 * still uses .btn / .btn-secondary for the embed "Open in new tab"
	 * anchor, so the rules remain there too; this duplication is
	 * intentional under Svelte's scoped-CSS model and will collapse
	 * once anchor styling moves to design tokens (follow-up to
	 * TASK-110).
	 */
	.btn {
		padding: 0.45rem 0.9rem;
		border-radius: 5px;
		font-size: 0.8125rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
	}

	.btn:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.btn-secondary {
		background: var(--color-bg);
		color: var(--color-text-muted);
		border-color: var(--color-border-strong);
	}

	.btn-secondary:hover {
		background: var(--color-surface-muted);
	}

	.validator-row .btn {
		text-decoration: none;
		display: inline-flex;
		align-items: center;
	}
</style>
