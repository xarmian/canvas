<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	export type InputVariant = 'text' | 'number' | 'color';
	export type InputSize = 'sm' | 'md';

	interface Props extends Omit<HTMLInputAttributes, 'value' | 'type' | 'size'> {
		/** Two-way bindable value. Always rendered as a string by the
		 *  underlying `<input>`; consumers using `type="number"` should
		 *  bind to a string and parse on read, OR rely on Svelte's native
		 *  `bind:value` numeric coercion (works because `type === 'number'`).
		 *  We keep the prop a string here so the component is generic and
		 *  the binding stays in the consumer's hands. */
		value?: string;
		/** Maps to `<input type>` plus styling tweaks for `color`. */
		type?: InputVariant;
		/** Padding scale. `md` matches the modal-row inputs in PublishModal,
		 *  `sm` matches the inline rows in CanvasSettingsModal. */
		size?: InputSize;
		/** Render in an error visual state (red border + ring). When paired
		 *  with `errorMessage`, the message is announced via `aria-describedby`. */
		invalid?: boolean;
		/** Optional error text rendered below the input. Linked to the input
		 *  via `aria-describedby` so screen readers announce it on focus. */
		errorMessage?: string;
		/** Optional descriptive id appended to `aria-describedby` (in addition
		 *  to the auto-generated error id). Useful when the consumer wants
		 *  to attach an external help-text element. */
		describedBy?: string;
		/** Native id. Required when the consumer renders a sibling `<label>` —
		 *  passed through unmodified. */
		id?: string;
		/** Optional extra class for one-off layout tweaks. Variant + size
		 *  styling stays canonical. */
		class?: HTMLInputAttributes['class'];
	}

	let {
		value = $bindable(''),
		type = 'text',
		size = 'md',
		invalid = false,
		errorMessage,
		describedBy,
		id,
		class: className,
		...rest
	}: Props = $props();

	// Auto-generate an error id linked to this input. Stable across rerenders
	// because $props() returns the same instance per render. We only emit it
	// when there's an error message to link to, keeping aria-describedby
	// short for the common case.
	const errorId = $derived(id ? `${id}-error` : undefined);

	const ariaDescribedBy = $derived(
		[errorMessage && errorId, describedBy].filter(Boolean).join(' ') || undefined
	);
</script>

<input
	{...rest}
	{id}
	{type}
	bind:value
	aria-invalid={invalid || undefined}
	aria-describedby={ariaDescribedBy}
	class={['input', `type-${type}`, `size-${size}`, invalid && 'is-invalid', className]}
/>
{#if errorMessage}
	<p id={errorId} class="error-text" role="alert">{errorMessage}</p>
{/if}

<style>
	.input {
		display: inline-block;
		font-family: inherit;
		font-size: 0.85rem;
		line-height: 1.3;
		color: #111;
		background: #fff;
		border: 1px solid #d1d5db;
		border-radius: 5px;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
		width: 100%;
		box-sizing: border-box;
	}

	.input::placeholder {
		color: #9ca3af;
	}

	.input:disabled {
		opacity: 0.65;
		cursor: not-allowed;
		background: #f9fafb;
	}

	.input:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}

	/* Sizes */
	.size-md {
		padding: 0.45rem 0.6rem;
	}

	.size-sm {
		padding: 0.35rem 0.5rem;
		font-size: 0.8125rem;
	}

	/* Type-specific */
	.type-number {
		font-variant-numeric: tabular-nums;
	}

	/* Native color inputs render a square swatch — collapse padding so the
	 * swatch fills the box, and use a fixed aspect-ratio so callers don't
	 * have to size by hand. Width still expands to fill its container, so
	 * wrap in a sized parent if a bigger swatch is desired. */
	.type-color {
		padding: 2px;
		height: 2.25rem;
		width: 2.5rem;
		cursor: pointer;
	}

	.size-sm.type-color {
		height: 2rem;
		width: 2.25rem;
	}

	/* Invalid state */
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
