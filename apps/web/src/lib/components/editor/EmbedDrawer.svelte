<script lang="ts">
	import { Code2, X } from '@lucide/svelte';
	import EmbedSnippets from './publish/EmbedSnippets.svelte';
	import type { PublishModalBinding } from './PublishModal.svelte';
	import { type ParamSchema } from '$lib/embed/snippets';

	/**
	 * "Get the code" drawer — right-side slide-out surface that hosts
	 * <EmbedSnippets>. Non-blocking by design (cf. <Modal>'s
	 * `dialog.showModal()` which inerts the rest of the page) so the
	 * user can keep editing the canvas / tweaking params while watching
	 * the snippet text update live. That live-edit loop is the core UX
	 * payoff of PLAN-232 Phase B.
	 *
	 * `paramSchemas` is now a prop fed from editor-page state (TASK-245).
	 * The drawer used to fetch its own `paramRows` independently; that
	 * lifecycle moved up so ParamsPanel + EmbedDrawer share one server
	 * roundtrip. `versionToken` is still drawer-owned because it's a
	 * separate `/version` endpoint with only one consumer.
	 *
	 * Dismissal:
	 *  - Close button in the header (always visible)
	 *  - Escape key, but ONLY while focus is inside the drawer. Without
	 *    that scope guard, the global Escape handler that clears the
	 *    canvas selection would never fire while the drawer is open,
	 *    and any other modal's Escape would close the drawer too.
	 *    (Codex round 1 P2 on TASK-239.)
	 *
	 * Click-outside does NOT close. The whole point of a non-blocking
	 * surface is that the user can click into the canvas / params
	 * panel without the drawer disappearing.
	 */
	interface Props {
		open: boolean;
		canvasId: string;
		slug: string;
		published: boolean;
		bindings?: PublishModalBinding[];
		liveValues?: Record<string, string>;
		/** Page-level derived from editor-page state. Replaces the
		 *  drawer's own `loadParamSchema` fetch in TASK-245. */
		paramSchemas: ParamSchema[];
		onClose: () => void;
		/** Optional handler invoked when the unpublished-state banner's
		 *  Publish button is clicked. The page wires this to the same
		 *  `openPublishModal()` the toolbar button uses, so the user
		 *  flow is "see snippets → publish via modal → snippets become
		 *  live" without re-implementing the publish call here.
		 *  TASK-242. */
		onPublish?: () => void;
	}

	let {
		open,
		canvasId,
		slug,
		published,
		bindings = [],
		liveValues = {},
		paramSchemas,
		onClose,
		onPublish
	}: Props = $props();

	/** `_v` token from /api/canvas/[id]/version — when present the
	 *  snippets emit immutable-cache URLs. Loads asynchronously; before
	 *  it arrives the snippets fall back to short-cache URLs. */
	let versionToken = $state<string | null>(null);
	/** Monotonic counter for version-token fetches — same stale-guard
	 *  pattern paramRows uses at the page layer. Without it, a late
	 *  completion from a previous canvas could write a stale `_v`
	 *  into the snippets for the new canvas. (Codex round 1 P2 of
	 *  TASK-240.) */
	let versionTokenGen = 0;
	/** Set once we've ATTEMPTED to load the version token for the
	 *  current open session — successful OR failed. Gates the
	 *  `$effect` away from a retry loop when the GET fails (Codex
	 *  round 1 P1 of TASK-240). */
	let versionTokenAttempted = $state(false);

	let drawerEl: HTMLElement | undefined = $state();

	$effect(() => {
		if (open && published && !versionTokenAttempted) {
			void loadVersionToken();
		}
		if (!open) {
			versionToken = null;
			versionTokenAttempted = false;
			versionTokenGen++;
		}
	});

	async function loadVersionToken(): Promise<void> {
		// Flip attempted=true SYNCHRONOUSLY before any await. Without
		// this, the $effect re-fires when loadParamSchema's
		// `paramRowsPending = true` write triggers a reactive tick,
		// `versionTokenAttempted` is still false at that point, and
		// a second concurrent `/version` request kicks off — its
		// late completion can mark a still-in-flight successful
		// first request as stale (Codex round 2 P3 of TASK-240).
		versionTokenAttempted = true;
		// Snapshot canvasId + bump-and-capture the generation. A late
		// completion whose canvasId or gen no longer matches drops its
		// `versionToken` write so a previous canvas's `_v` can't bleed
		// into the new canvas's snippets. (Codex round 1 P2 of TASK-240.)
		const requestCanvasId = canvasId;
		const requestGen = ++versionTokenGen;
		const isStale = () => requestCanvasId !== canvasId || requestGen !== versionTokenGen;
		try {
			const res = await fetch(`/api/canvas/${canvasId}/version`);
			if (isStale()) return;
			if (!res.ok) return;
			const data = (await res.json()) as { token: string };
			if (isStale()) return;
			versionToken = data.token;
		} catch {
			// Best-effort — falling back to short-cache URLs is fine.
		}
	}

	// paramSchemas derivation moved to editor-page state in TASK-245
	// (single source of truth for paramRows). The drawer just renders
	// whatever the page hands it.

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key !== 'Escape') return;
		// Only handle Escape when focus is INSIDE the drawer. Without
		// this guard the drawer steals the editor's selection-clear
		// Escape shortcut and can close itself while another modal owns
		// focus. Codex round 1 P2 on TASK-239.
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
		{#if !published}
			<!--
				Pre-publish banner (TASK-242). The snippets below
				point at the canvas's eventual share URL — they
				render so developers can plan their integration
				before publish, but `/c/{slug}` and `/image.png`
				404 until the canvas is published. The banner
				makes that explicit and offers a one-click route
				into the publish flow. Clicking "Publish now"
				delegates to the page-level publish handler (same
				one the toolbar button uses) — keeps onBeforePublish
				flushing + the modal's confirmation step in one
				canonical path.
			-->
			<aside class="pre-publish-banner" data-testid="embed-drawer-pre-publish-banner">
				<div class="pre-publish-copy">
					<strong>Not yet published.</strong>
					Snippets below preview the eventual share URL — they'll 404 until you publish.
				</div>
				{#if onPublish}
					<button
						type="button"
						class="pre-publish-cta"
						data-testid="embed-drawer-publish-cta"
						onclick={onPublish}
					>
						Publish now
					</button>
				{/if}
			</aside>
		{/if}
		<EmbedSnippets {slug} {bindings} {liveValues} {paramSchemas} {versionToken} />
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

	.pre-publish-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin: 0 0 1rem;
		padding: 0.6rem 0.75rem;
		background: var(--color-warning-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 5px;
		font-size: 0.8125rem;
		color: var(--color-warning-text);
		line-height: 1.4;
	}

	.pre-publish-copy {
		flex: 1 1 auto;
	}

	.pre-publish-copy strong {
		display: block;
		margin-bottom: 0.15rem;
	}

	.pre-publish-cta {
		flex: 0 0 auto;
		padding: 0.35rem 0.7rem;
		font-size: 0.75rem;
		font-weight: 600;
		border-radius: 4px;
		border: 1px solid var(--color-warning-border);
		background: var(--color-bg);
		color: var(--color-warning-text);
		cursor: pointer;
	}

	.pre-publish-cta:hover {
		background: var(--color-warning-border);
	}

	.pre-publish-cta:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}
</style>
