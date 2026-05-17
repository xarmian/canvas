/**
 * Toast notification store.
 *
 * Usage:
 *   import { toast } from '$lib/stores/toast.svelte';
 *   toast.success('Saved');
 *   toast.error('Save failed', { action: { label: 'Retry', onClick: () => save() } });
 */

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastItem {
	id: string;
	message: string;
	variant: ToastVariant;
	action?: ToastAction;
	/** ms before auto-dismiss; 0 = sticky until user dismisses */
	duration: number;
	createdAt: number;
}

interface ToastOptions {
	action?: ToastAction;
	duration?: number;
}

const DEFAULT_DURATION: Record<ToastVariant, number> = {
	success: 3000,
	info: 4000,
	// errors persist longer (or forever if they have an action) so users can react
	error: 6000
};

function createToastStore() {
	const items = $state<ToastItem[]>([]);

	function push(variant: ToastVariant, message: string, options: ToastOptions = {}): string {
		const id =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? crypto.randomUUID()
				: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		// Errors with an action default to sticky (duration 0) so users don't miss the retry.
		const defaultDuration = options.action && variant === 'error' ? 0 : DEFAULT_DURATION[variant];
		const duration = options.duration ?? defaultDuration;

		const item: ToastItem = {
			id,
			message,
			variant,
			action: options.action,
			duration,
			createdAt: Date.now()
		};

		items.push(item);

		if (duration > 0 && typeof window !== 'undefined') {
			window.setTimeout(() => dismiss(id), duration);
		}

		return id;
	}

	function dismiss(id: string) {
		const idx = items.findIndex((t) => t.id === id);
		if (idx !== -1) items.splice(idx, 1);
	}

	function clear() {
		items.length = 0;
	}

	return {
		get items() {
			return items;
		},
		success: (message: string, options?: ToastOptions) => push('success', message, options),
		error: (message: string, options?: ToastOptions) => push('error', message, options),
		info: (message: string, options?: ToastOptions) => push('info', message, options),
		dismiss,
		clear
	};
}

export const toast = createToastStore();
