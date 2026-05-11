<script lang="ts">
	import { X } from '@lucide/svelte';
	import { toast, type ToastItem } from '$lib/stores/toast.svelte';

	function dismiss(id: string) {
		toast.dismiss(id);
	}

	function runAction(item: ToastItem) {
		item.action?.onClick();
		toast.dismiss(item.id);
	}
</script>

<div class="toaster" aria-live="polite" aria-atomic="false">
	{#each toast.items as item (item.id)}
		<div class="toast toast-{item.variant}" role="status">
			<span class="toast-message">{item.message}</span>
			{#if item.action}
				<button type="button" class="toast-action" onclick={() => runAction(item)}>
					{item.action.label}
				</button>
			{/if}
			<button
				type="button"
				class="toast-dismiss"
				aria-label="Dismiss"
				onclick={() => dismiss(item.id)}
			>
				<X size={16} />
			</button>
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		bottom: 1rem;
		right: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		z-index: 9999;
		pointer-events: none;
		max-width: min(24rem, calc(100vw - 2rem));
	}

	.toast {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: var(--spacing-3);
		padding: var(--spacing-3);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		font-size: var(--text-base);
		line-height: 1.4;
		color: var(--color-bg);
		animation: slide-in 0.2s ease-out;
	}

	@keyframes slide-in {
		from {
			transform: translateX(20px);
			opacity: 0;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}

	.toast-success {
		background: var(--color-success);
	}

	.toast-error {
		background: var(--color-danger);
	}

	.toast-info {
		background: var(--color-text);
	}

	.toast-message {
		flex: 1;
	}

	.toast-action {
		background: rgba(255, 255, 255, 0.2);
		color: var(--color-bg);
		border: 1px solid rgba(255, 255, 255, 0.35);
		padding: var(--spacing-1) var(--spacing-2);
		border-radius: var(--radius-sm);
		font-size: var(--text-sm);
		font-weight: 500;
		cursor: pointer;
	}

	.toast-action:hover {
		background: rgba(255, 255, 255, 0.3);
	}

	.toast-action:focus-visible {
		outline: 2px solid var(--color-bg);
		outline-offset: 2px;
	}

	.toast-dismiss {
		background: none;
		border: none;
		color: var(--color-bg);
		font-size: var(--text-xl);
		line-height: 1;
		padding: 0 var(--spacing-1);
		cursor: pointer;
		opacity: 0.8;
		border-radius: var(--radius-sm);
	}

	.toast-dismiss:hover {
		opacity: 1;
	}

	.toast-dismiss:focus-visible {
		outline: 2px solid var(--color-bg);
		outline-offset: 2px;
	}
</style>
