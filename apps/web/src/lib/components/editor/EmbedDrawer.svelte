<script lang="ts">
	import { Code2, X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	/**
	 * "Get the code" drawer — right-side slide-out surface that hosts
	 * <EmbedSnippets> (TASK-240). Unlike <Modal> (which uses
	 * `dialog.showModal()` and inerts the rest of the page), this drawer
	 * is non-blocking so the user can keep editing the canvas / tweaking
	 * params while watching the snippet text update live. That live-edit
	 * loop is the core UX payoff of PLAN-232 Phase B.
	 *
	 * Shell only — this task (TASK-239) just establishes the surface and
	 * its open/close lifecycle. TASK-240 wires <EmbedSnippets> as the
	 * content; until then, callers pass any content via the `children`
	 * snippet (or leave it empty).
	 *
	 * Dismissal:
	 *  - Close button in the header (always visible)
	 *  - Escape key, but ONLY while focus is inside the drawer. Without
	 *    that scope guard, the global Escape handler that clears the
	 *    canvas selection would never fire while the drawer is open,
	 *    and any other modal's Escape would close the drawer too.
	 *    (Codex round 1 P2.)
	 *
	 * Click-outside does NOT close. The whole point of a non-blocking
	 * surface is that the user can click into the canvas / params panel
	 * without the drawer disappearing. (Modal's blocking semantics
	 * naturally close on backdrop click; here the editor IS the
	 * "backdrop.")
	 *
	 * The drawer is fixed to the right edge of the viewport so it
	 * overlays PropertyPanel rather than displacing it. The user closes
	 * the drawer to reach PropertyPanel again. PLAN-232 Phase C will
	 * revisit panel coexistence if it becomes an issue.
	 */
	interface Props {
		open: boolean;
		onClose: () => void;
		/** Optional drawer body. Empty during TASK-239; TASK-240 mounts
		 *  <EmbedSnippets>. */
		children?: Snippet;
	}

	let { open, onClose, children }: Props = $props();

	let drawerEl: HTMLElement | undefined = $state();

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key !== 'Escape') return;
		// Only handle Escape when focus is INSIDE the drawer. Without
		// this guard the drawer steals the editor's selection-clear
		// Escape shortcut (apps/web/src/routes/(app)/canvas/[id]/edit/+page.svelte)
		// and can also close itself while a modal owns focus. Codex
		// round 1 P2.
		if (!drawerEl?.contains(document.activeElement)) return;
		event.preventDefault();
		onClose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<aside
	bind:this={drawerEl}
	class="embed-drawer"
	class:open
	aria-label="Embed code"
	aria-hidden={!open}
	inert={!open}
	data-testid="embed-drawer"
>
	<header class="drawer-header">
		<div class="title">
			<Code2 size={16} />
			<h2>Get the code</h2>
		</div>
		<button
			type="button"
			class="close-btn"
			data-testid="embed-drawer-close"
			aria-label="Close embed drawer"
			onclick={onClose}
		>
			<X size={16} />
		</button>
	</header>

	<div class="drawer-body" data-testid="embed-drawer-body">
		{#if children}
			{@render children()}
		{:else}
			<!--
				Empty during TASK-239. <EmbedSnippets> lands here in
				TASK-240. Keeping the empty state intentionally blank so
				it's visually obvious during the shell-only PR.
			-->
		{/if}
	</div>
</aside>

<style>
	.embed-drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(420px, 92vw);
		background: var(--color-bg);
		border-left: 1px solid var(--color-border);
		box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
		display: flex;
		flex-direction: column;
		transform: translateX(100%);
		transition: transform 180ms ease-out;
		z-index: 30;
		/* Visually hide while closed so the off-screen panel doesn't
		   catch pointer events on overflow edges. `inert` (set via
		   attribute above) blocks focus + clicks too. */
		visibility: hidden;
	}

	.embed-drawer.open {
		transform: translateX(0);
		visibility: visible;
	}

	.drawer-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--color-border);
		flex: 0 0 auto;
	}

	.title {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-text);
	}

	.title h2 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.close-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--color-text-muted);
		border-radius: 4px;
		cursor: pointer;
	}

	.close-btn:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.close-btn:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.drawer-body {
		flex: 1 1 auto;
		overflow-y: auto;
		padding: 1rem;
	}
</style>
