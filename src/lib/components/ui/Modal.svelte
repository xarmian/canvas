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
		border-radius: 10px;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
		width: min(var(--modal-width), calc(100vw - 2rem));
		max-height: calc(100vh - 2rem);
		background: #fff;
		color: #111;
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
		padding: 1rem 1.25rem;
		border-bottom: 1px solid #eee;
	}

	.modal-title {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}

	.modal-close {
		background: none;
		border: none;
		font-size: 1.5rem;
		line-height: 1;
		color: #666;
		cursor: pointer;
		padding: 0 0.25rem;
		border-radius: 4px;
	}

	.modal-close:hover {
		background: #f3f4f6;
		color: #111;
	}

	.modal-close:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}

	.modal-body {
		padding: 1.25rem;
		overflow: auto;
	}

	.modal-footer {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
		padding: 0.875rem 1.25rem;
		border-top: 1px solid #eee;
		background: #fafafa;
	}
</style>
