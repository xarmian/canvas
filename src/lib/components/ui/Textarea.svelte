<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import type { InputSize } from './Input.svelte';

	interface Props extends Omit<HTMLTextareaAttributes, 'value'> {
		/** Two-way bindable value. */
		value?: string;
		/** Padding scale, mirrors Input. */
		size?: InputSize;
		/** Render in an error visual state. Pair with `errorMessage` for
		 *  screen-reader announcement via `aria-describedby`. */
		invalid?: boolean;
		/** Optional error text rendered below. */
		errorMessage?: string;
		/** Optional descriptive id appended to `aria-describedby`. */
		describedBy?: string;
		/** Native id. Required when the consumer renders a sibling `<label>`. */
		id?: string;
		class?: HTMLTextareaAttributes['class'];
	}

	let {
		value = $bindable(''),
		size = 'md',
		invalid = false,
		errorMessage,
		describedBy,
		id,
		rows = 3,
		class: className,
		'aria-describedby': consumerAriaDescribedBy,
		...rest
	}: Props = $props();

	// Stable SSR-safe id used as a fallback when the consumer didn't pass
	// `id`. Mirrors Input.svelte (Codex round 1 P2).
	const uid = $props.id();
	const errorId = $derived(`${id ?? uid}-error`);

	// Merge the consumer's native `aria-describedby` with our error id and
	// optional `describedBy` (Codex round 2 P2 — without this, the
	// explicit attribute below overwrites the spread).
	const ariaDescribedBy = $derived(
		[errorMessage && errorId, describedBy, consumerAriaDescribedBy].filter(Boolean).join(' ') ||
			undefined
	);
</script>

<textarea
	{...rest}
	{id}
	{rows}
	bind:value
	aria-invalid={invalid || undefined}
	aria-describedby={ariaDescribedBy}
	class={['textarea', `size-${size}`, invalid && 'is-invalid', className]}
></textarea>
{#if errorMessage}
	<p id={errorId} class="error-text" role="alert">{errorMessage}</p>
{/if}

<style>
	.textarea {
		display: block;
		width: 100%;
		box-sizing: border-box;
		font-family: inherit;
		font-size: 0.85rem;
		line-height: 1.4;
		color: #111;
		background: #fff;
		border: 1px solid #d1d5db;
		border-radius: 5px;
		resize: vertical;
		min-height: 2.5rem;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.textarea::placeholder {
		color: #9ca3af;
	}

	.textarea:disabled {
		opacity: 0.65;
		cursor: not-allowed;
		background: #f9fafb;
	}

	.textarea:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}

	.size-md {
		padding: 0.5rem 0.6rem;
	}

	.size-sm {
		padding: 0.35rem 0.5rem;
		font-size: 0.8125rem;
	}

	.is-invalid {
		border-color: #dc2626;
	}

	.is-invalid:focus-visible {
		outline-color: #dc2626;
	}

	.error-text {
		margin: 0.3rem 0 0;
		font-size: 0.75rem;
		color: #991b1b;
		line-height: 1.4;
	}
</style>
