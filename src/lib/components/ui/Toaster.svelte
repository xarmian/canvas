<script lang="ts">
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
				&times;
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
		gap: 0.75rem;
		padding: 0.75rem 0.875rem;
		border-radius: 8px;
		box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
		font-size: 0.875rem;
		line-height: 1.4;
		color: #fff;
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
		background: #16a34a;
	}

	.toast-error {
		background: #dc2626;
	}

	.toast-info {
		background: #1f2937;
	}

	.toast-message {
		flex: 1;
	}

	.toast-action {
		background: rgba(255, 255, 255, 0.2);
		color: #fff;
		border: 1px solid rgba(255, 255, 255, 0.35);
		padding: 0.25rem 0.625rem;
		border-radius: 4px;
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
	}

	.toast-action:hover {
		background: rgba(255, 255, 255, 0.3);
	}

	.toast-action:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}

	.toast-dismiss {
		background: none;
		border: none;
		color: #fff;
		font-size: 1.25rem;
		line-height: 1;
		padding: 0 0.25rem;
		cursor: pointer;
		opacity: 0.8;
		border-radius: 4px;
	}

	.toast-dismiss:hover {
		opacity: 1;
	}

	.toast-dismiss:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}
</style>
