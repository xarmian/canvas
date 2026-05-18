<script lang="ts">
	import { Code2, X } from '@lucide/svelte';
	import EmbedSnippets from './publish/EmbedSnippets.svelte';
	import type { PublishModalBinding } from './PublishModal.svelte';
	import { type ParamSchema, type ParamType } from '$lib/embed/snippets';

	/**
	 * "Get the code" drawer — right-side slide-out surface that hosts
	 * <EmbedSnippets>. Non-blocking by design (cf. <Modal>'s
	 * `dialog.showModal()` which inerts the rest of the page) so the
	 * user can keep editing the canvas / tweaking params while watching
	 * the snippet text update live. That live-edit loop is the core UX
	 * payoff of PLAN-232 Phase B.
	 *
	 * Owns its own `paramRows` + `versionToken` fetches keyed on
	 * `canvasId` + `open`. Independent of PublishModal's identical
	 * fetches — TASK-245 (the Phase C "single source of truth for
	 * paramRows" task) is what de-duplicates them at editor-page
	 * state. Until then: one extra GET when both drawer + modal are
	 * open simultaneously, which is uncommon and acceptable.
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
		onClose: () => void;
	}

	let {
		open,
		canvasId,
		slug,
		published,
		bindings = [],
		liveValues = {},
		onClose
	}: Props = $props();

	/** Param schema row as returned by GET /api/canvas/[id]/params. */
	interface ParamRow {
		name: string;
		type: string;
		required: boolean;
	}
	let paramRows = $state<ParamRow[]>([]);
	let paramRowsLoaded = $state(false);
	/** Monotonic counter — bumped at request start; a late completion
	 *  whose generation no longer matches drops its writes. Mirrors the
	 *  pattern PublishModal uses (Codex round 1 P2 of TASK-136). */
	let paramRowsGen = 0;
	/** In-flight gate so the open-effect re-running (e.g. when
	 *  `published` flips) doesn't kick off a second concurrent GET. */
	let paramRowsPending = $state(false);

	/** `_v` token from /api/canvas/[id]/version — when present the
	 *  snippets emit immutable-cache URLs. Loads asynchronously; before
	 *  it arrives the snippets fall back to short-cache URLs. */
	let versionToken = $state<string | null>(null);
	/** Monotonic counter for version-token fetches — same stale-guard
	 *  pattern as `paramRowsGen`. Without it, a late completion from a
	 *  previous canvas could write a stale `_v` into the snippets for
	 *  the new canvas. (Codex round 1 P2 of TASK-240.) */
	let versionTokenGen = 0;
	/** Set once we've ATTEMPTED to load the version token for the
	 *  current open session — successful OR failed. Gates the
	 *  `$effect` away from a retry loop when the GET fails (Codex
	 *  round 1 P1 of TASK-240). */
	let versionTokenAttempted = $state(false);

	let drawerEl: HTMLElement | undefined = $state();

	$effect(() => {
		if (open && published && !paramRowsLoaded && !paramRowsPending) {
			void loadParamSchema();
		}
		if (open && published && !versionTokenAttempted) {
			void loadVersionToken();
		}
		if (!open) {
			// Reset so reopening for a different canvas refetches. Bump
			// both generation counters so any in-flight load from this
			// open is treated as stale on completion.
			paramRowsLoaded = false;
			paramRows = [];
			paramRowsGen++;
			paramRowsPending = false;
			versionToken = null;
			versionTokenAttempted = false;
			versionTokenGen++;
		}
	});

	async function loadParamSchema(): Promise<void> {
		paramRowsPending = true;
		const requestCanvasId = canvasId;
		const requestGen = ++paramRowsGen;
		const isStale = () => requestCanvasId !== canvasId || requestGen !== paramRowsGen;
		try {
			const res = await fetch(`/api/canvas/${canvasId}/params`);
			if (isStale()) return;
			if (!res.ok) {
				// Snippets degrade gracefully when the schema hasn't
				// loaded (typed-TS falls back to all-strings; example
				// query still works off bindings). Mark `loaded=true`
				// even on the failure path so the $effect doesn't
				// re-enter and tight-loop the GET. Codex round 1 P1
				// of TASK-240.
				paramRowsLoaded = true;
				return;
			}
			const rows = (await res.json()) as ParamRow[];
			if (isStale()) return;
			paramRows = rows;
			paramRowsLoaded = true;
		} catch {
			// Same rationale — silent fallback, but still flip the
			// loaded flag so we don't retry.
			if (!isStale()) {
				paramRowsLoaded = true;
			}
		} finally {
			if (requestGen === paramRowsGen) {
				paramRowsPending = false;
			}
		}
	}

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

	/** Map paramRows → ParamSchema[] for the typed-TS / Python snippet
	 *  generators. Unknown types collapse to 'text' so the snippets stay
	 *  runnable rather than emitting `: unknown`. */
	const KNOWN_PARAM_TYPES: readonly ParamType[] = ['text', 'number', 'boolean', 'url', 'date'];
	function toParamType(raw: string): ParamType {
		return (KNOWN_PARAM_TYPES as readonly string[]).includes(raw) ? (raw as ParamType) : 'text';
	}
	let paramSchemas = $derived<ParamSchema[]>(
		paramRows.map((r) => ({ name: r.name, type: toParamType(r.type) }))
	);

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
		<!--
			TODO(TASK-242): when `published === false` the snippets here
			still render copyable `/c/{slug}` + `/image.png` URLs that
			404. TASK-242 is the planned home for the pre-publish UX
			(banner + inline publish CTA per the plan recommendation).
			Until then, opening the drawer pre-publish surfaces snippets
			pointing at the eventual share URL — incorrect for v1 but
			documented + fenced into the next task.
		-->
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
</style>
