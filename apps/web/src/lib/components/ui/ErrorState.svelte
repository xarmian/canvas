<script lang="ts">
	import { AlertCircle } from '@lucide/svelte';

	interface Props {
		/** Headline copy. Defaults to "Something went wrong" — override
		 *  for context-specific phrasing (e.g. "Couldn't load assets"). */
		title?: string;
		/** Description / suggested next step. Required so users aren't
		 *  staring at a generic title with no path forward. */
		message: string;
		/** Optional retry callback. When set, renders a focused, keyboard-
		 *  accessible "Try again" button below the message. The button is
		 *  a plain `<button>` rather than the Button primitive to avoid a
		 *  cycle (ErrorState may be rendered before any other primitive
		 *  has been migrated). */
		onRetry?: () => void;
		/** Override the retry button label. Defaults to "Try again". */
		retryLabel?: string;
	}

	let {
		title = 'Something went wrong',
		message,
		onRetry,
		retryLabel = 'Try again'
	}: Props = $props();
</script>

<div class="error-state" role="alert">
	<span class="error-icon" aria-hidden="true">
		<AlertCircle size={28} />
	</span>
	<h3 class="error-title">{title}</h3>
	<p class="error-message">{message}</p>
	{#if onRetry}
		<button type="button" class="error-retry" onclick={onRetry}>
			{retryLabel}
		</button>
	{/if}
</div>

<style>
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.4rem;
		padding: 1.25rem 1rem;
		max-width: 28rem;
		margin: 0 auto;
		color: #7f1d1d;
		background: #fef2f2;
		border: 1px solid #fecaca;
		border-radius: 6px;
	}

	.error-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 9999px;
		background: #fee2e2;
		color: #b91c1c;
		margin-bottom: 0.2rem;
	}

	.error-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: #991b1b;
		line-height: 1.3;
	}

	.error-message {
		margin: 0;
		font-size: 0.875rem;
		color: #7f1d1d;
		line-height: 1.5;
	}

	.error-retry {
		margin-top: 0.6rem;
		padding: 0.4rem 0.9rem;
		font-size: 0.8125rem;
		font-weight: 500;
		font-family: inherit;
		border-radius: 5px;
		border: 1px solid #b91c1c;
		background: #fff;
		color: #991b1b;
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}

	.error-retry:hover {
		background: #b91c1c;
		color: #fff;
	}

	.error-retry:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}
</style>
