<script lang="ts">
	import Modal from './Modal.svelte';

	interface Props {
		open: boolean;
		title: string;
		message: string;
		/** Confirm button label, e.g. "Delete". Default "Confirm". */
		confirmLabel?: string;
		/** Cancel button label. Default "Cancel". */
		cancelLabel?: string;
		/** 'default' uses neutral styling, 'danger' uses a red confirm button. */
		variant?: 'default' | 'danger';
		onConfirm: () => void;
		onCancel: () => void;
	}

	let {
		open,
		title,
		message,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		variant = 'default',
		onConfirm,
		onCancel
	}: Props = $props();
</script>

<Modal {open} {title} width="24rem" onClose={onCancel}>
	<p class="message">{message}</p>
	{#snippet footer()}
		<button type="button" class="btn btn-cancel" onclick={onCancel}>
			{cancelLabel}
		</button>
		<button
			type="button"
			class="btn"
			class:btn-confirm={variant === 'default'}
			class:btn-danger={variant === 'danger'}
			onclick={onConfirm}
		>
			{confirmLabel}
		</button>
	{/snippet}
</Modal>

<style>
	.message {
		margin: 0;
		color: #333;
		line-height: 1.5;
	}

	.btn {
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	.btn:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}

	.btn-cancel {
		background: #fff;
		color: #333;
		border-color: #d1d5db;
	}

	.btn-cancel:hover {
		background: #f3f4f6;
	}

	.btn-confirm {
		background: #111;
		color: #fff;
	}

	.btn-confirm:hover {
		background: #333;
	}

	.btn-danger {
		background: #dc2626;
		color: #fff;
	}

	.btn-danger:hover {
		background: #b91c1c;
	}
</style>
