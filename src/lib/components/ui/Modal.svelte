<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';

	interface Props {
		open: boolean;
		title?: string;
		/** Width of the modal in CSS units (e.g. '32rem'). */
		width?: string;
		/** Whether pressing Escape or clicking the backdrop closes the modal. Default true. */
		dismissible?: boolean;
		onClose: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	let {
		open,
		title,
		width = '32rem',
		dismissible = true,
		onClose,
		children,
		footer
	}: Props = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);

	// Sync the <dialog> element's open state with the prop.
	$effect(() => {
		if (!dialogEl) return;
		if (open && !dialogEl.open) {
			dialogEl.showModal();
		} else if (!open && dialogEl.open) {
			dialogEl.close();
		}
	});

	function handleCancel(e: Event) {
		// Fired on Escape press (native <dialog> behavior).
		e.preventDefault();
		if (dismissible) onClose();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (!dismissible) return;
		// Close only when the click is on the dialog element itself (the backdrop),
		// not on any child content.
		if (e.target === dialogEl) onClose();
	}
</script>

<dialog
	bind:this={dialogEl}
	class="modal"
	style="--modal-width: {width};"
	onclose={() => {
		if (open) onClose();
	}}
	oncancel={handleCancel}
	onclick={handleBackdropClick}
>
	<div class="modal-content" role="document">
		{#if title}
			<header class="modal-header">
				<h2 class="modal-title">{title}</h2>
				{#if dismissible}
					<button type="button" class="modal-close" aria-label="Close" onclick={onClose}>
						<X size={18} />
					</button>
				{/if}
			</header>
		{/if}
		<div class="modal-body">
			{@render children()}
		</div>
		{#if footer}
			<footer class="modal-footer">
				{@render footer()}
			</footer>
		{/if}
	</div>
</dialog>

<style>
	.modal {
		padding: 0;
		border: none;
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-modal);
		width: min(var(--modal-width), calc(100vw - 2rem));
		max-height: calc(100vh - 2rem);
		background: var(--color-bg);
		color: var(--color-text);
	}

	.modal::backdrop {
		background: rgba(0, 0, 0, 0.45);
	}

	.modal-content {
		display: flex;
		flex-direction: column;
		max-height: calc(100vh - 2rem);
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--spacing-4) var(--spacing-6);
		border-bottom: 1px solid var(--color-border);
	}

	.modal-title {
		margin: 0;
		font-size: var(--text-md);
		font-weight: 600;
	}

	.modal-close {
		background: none;
		border: none;
		font-size: var(--text-2xl);
		line-height: 1;
		color: var(--color-text-muted);
		cursor: pointer;
		padding: 0 var(--spacing-1);
		border-radius: var(--radius-sm);
	}

	.modal-close:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.modal-close:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.modal-body {
		padding: var(--spacing-6);
		overflow: auto;
	}

	.modal-footer {
		display: flex;
		gap: var(--spacing-2);
		justify-content: flex-end;
		padding: var(--spacing-3) var(--spacing-6);
		border-top: 1px solid var(--color-border);
		background: var(--color-surface);
	}
</style>
