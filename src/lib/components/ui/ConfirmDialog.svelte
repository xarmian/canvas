<script lang="ts">
	import Modal from './Modal.svelte';
	import Button from './Button.svelte';

	interface Props {
		open: boolean;
		title: string;
		message: string;
		/** Confirm button label, e.g. "Delete". Default "Confirm". */
		confirmLabel?: string;
		/** Cancel button label. Default "Cancel". */
		cancelLabel?: string;
		/** 'default' uses the canonical primary CTA, 'danger' uses the
		 *  red destructive variant. Per TASK-120 the audit's "Confirm"
		 *  pattern maps to the `primary` Button variant — the previous
		 *  dark `.btn-confirm` was an inconsistency we're now retiring. */
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
		<Button variant="secondary" onclick={onCancel}>
			{cancelLabel}
		</Button>
		<Button variant={variant === 'danger' ? 'danger' : 'primary'} onclick={onConfirm}>
			{confirmLabel}
		</Button>
	{/snippet}
</Modal>

<style>
	.message {
		margin: 0;
		color: var(--color-text-muted);
		line-height: 1.5;
	}
</style>
