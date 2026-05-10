<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'copy' | 'link';
	export type ButtonSize = 'sm' | 'md';

	interface Props extends HTMLButtonAttributes {
		/** Visual variant. Maps 1:1 to the inline `.btn-*` classes that
		 *  are re-defined across PublishModal / ConfirmDialog / etc. */
		variant?: ButtonVariant;
		/** `sm` is the compact size used in inline rows (e.g. slug
		 *  suggestion chip), `md` is the default modal-footer size. */
		size?: ButtonSize;
		/** Shows an inline spinner before the label and prevents clicks
		 *  while pending. The label stays rendered so the button width
		 *  doesn't collapse mid-request. */
		loading?: boolean;
		/** Button content — text, icons, or a mix. */
		children?: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		disabled = false,
		loading = false,
		type = 'button',
		class: className,
		onclick,
		children,
		...rest
	}: Props = $props();

	function handleClick(event: MouseEvent) {
		if (disabled || loading) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		// Svelte's typed event handlers receive `MouseEvent & { currentTarget: HTMLButtonElement }`.
		// Casting here keeps the generated handler signature aligned with HTMLButtonAttributes.
		onclick?.(event as MouseEvent & { currentTarget: EventTarget & HTMLButtonElement });
	}
</script>

<button
	{...rest}
	{type}
	class={['btn', `btn-${variant}`, `size-${size}`, loading && 'is-loading', className]}
	disabled={disabled || loading}
	aria-busy={loading || undefined}
	onclick={handleClick}
>
	{#if loading}
		<span class="spinner" aria-hidden="true"></span>
	{/if}
	{#if children}
		{@render children()}
	{/if}
</button>

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		border-radius: 5px;
		font-weight: 500;
		font-family: inherit;
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
		text-decoration: none;
		line-height: 1.2;
	}

	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}

	/* Sizes */
	.size-md {
		padding: 0.45rem 0.9rem;
		font-size: 0.8125rem;
	}

	.size-sm {
		padding: 0.25rem 0.55rem;
		font-size: 0.75rem;
	}

	/* Variants */
	.btn-primary {
		background: #2563eb;
		color: #fff;
	}

	.btn-primary:hover:not(:disabled) {
		background: #1d4ed8;
	}

	.btn-secondary {
		background: #fff;
		color: #374151;
		border-color: #d1d5db;
	}

	.btn-secondary:hover:not(:disabled) {
		background: #f3f4f6;
	}

	.btn-danger {
		background: #dc2626;
		color: #fff;
	}

	.btn-danger:hover:not(:disabled) {
		background: #b91c1c;
	}

	.btn-copy {
		background: #111;
		color: #fff;
	}

	.btn-copy:hover:not(:disabled) {
		background: #333;
	}

	.btn-link {
		background: none;
		color: #2563eb;
		padding-inline: 0.4rem;
	}

	.btn-link:hover:not(:disabled) {
		text-decoration: underline;
	}

	/* Loading spinner */
	.spinner {
		width: 0.85em;
		height: 0.85em;
		border-radius: 50%;
		border: 2px solid currentColor;
		border-right-color: transparent;
		animation: spin 0.7s linear infinite;
		display: inline-block;
		flex-shrink: 0;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Respect reduced-motion: hold the spinner static rather than
	 * animating it. The aria-busy attr still announces pending. */
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
</style>
