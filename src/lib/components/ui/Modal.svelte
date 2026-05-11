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
		/** CSS selector for the element that should receive focus when the
		 *  modal opens. Scoped to the dialog's content. If omitted, the
		 *  first focusable element inside the body or footer is focused —
		 *  the header's close button is intentionally skipped per the
		 *  TASK-144 audit (landing initial focus on "X" hides the modal's
		 *  real CTA from keyboard / screen-reader users). */
		initialFocus?: string;
		onClose: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	let {
		open,
		title,
		width = '32rem',
		dismissible = true,
		initialFocus,
		onClose,
		children,
		footer
	}: Props = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);

	/** Element that held focus when the modal opened. Restored on close
	 *  so keyboard users return to the trigger they activated — without
	 *  this the focus indicator lands on `<body>` (effectively nowhere),
	 *  which is jarring for screen-reader users and breaks tab-order
	 *  for sighted keyboard users. The browser does NOT do this for us
	 *  automatically — modal `<dialog>` only manages focus *while* open. */
	let previouslyFocusedEl: HTMLElement | null = null;

	/** Standard focusable-elements query. Disabled controls and explicit
	 *  `tabindex="-1"` opt-outs are excluded; positive tabindex is left
	 *  in because the modal author may have a reason for it. */
	const FOCUSABLE_SELECTOR =
		'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

	function focusInitialElement(): void {
		if (!dialogEl) return;

		// Caller-specified target wins. Scope to the dialog so a stray
		// selector can't reach across pages.
		if (initialFocus) {
			const target = dialogEl.querySelector<HTMLElement>(initialFocus);
			if (target && typeof target.focus === 'function') {
				target.focus();
				return;
			}
		}

		// Default: first focusable in body or footer — skip the header's
		// close button. The audit explicitly calls out close-button-first
		// as an anti-pattern. We query within each container so the
		// resulting NodeList walks body before footer in DOM order.
		const containers = dialogEl.querySelectorAll<HTMLElement>('.modal-body, .modal-footer');
		for (const container of containers) {
			const candidates = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
			for (const el of candidates) {
				el.focus();
				// Defensive: if the element refused focus (e.g. visibility:hidden
				// in some intermediate state), document.activeElement won't have
				// switched and we'll fall through to the next candidate.
				if (document.activeElement === el) return;
			}
		}

		// No focusable content at all (rare — e.g. an "are you sure?"
		// modal with only a title). Focus the dialog itself so keyboard
		// users have a defined starting point and Tab still cycles
		// within the dialog rather than escaping to the now-inert page.
		dialogEl.focus();
	}

	// Sync the <dialog> element's open state with the prop, and manage
	// the focus contract on each transition.
	//
	// Focus trap NOTE: we do NOT implement a manual Tab-cycle trap.
	// `dialog.showModal()` makes the rest of the document inert in
	// every modern engine (Chromium, Gecko, WebKit), so Tab / Shift+Tab
	// already cycle only within the dialog's focusable elements per
	// the HTML spec. The two pieces the browser does NOT give us are
	// (a) overriding its first-focusable auto-focus choice (it would
	// land on `.modal-close`), and (b) restoring focus to the opener
	// on close — both handled below.
	$effect(() => {
		if (!dialogEl) return;
		if (open && !dialogEl.open) {
			previouslyFocusedEl =
				document.activeElement instanceof HTMLElement ? document.activeElement : null;
			dialogEl.showModal();
			// showModal()'s auto-focus pick is queued; defer ours one
			// microtask so we override it deterministically rather than
			// racing.
			queueMicrotask(focusInitialElement);
		} else if (!open && dialogEl.open) {
			dialogEl.close();
			// Restore focus to the opener. Guard against the element
			// being detached (e.g. the trigger was removed by a
			// navigation while the modal was open) — focus() on a
			// detached node is a no-op, but `.contains()` makes the
			// intent explicit and silences linters.
			const restoreTarget = previouslyFocusedEl;
			previouslyFocusedEl = null;
			if (restoreTarget && document.body.contains(restoreTarget)) {
				try {
					restoreTarget.focus();
				} catch {
					/* element no longer focusable — silent fall-through */
				}
			}
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
	tabindex="-1"
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
