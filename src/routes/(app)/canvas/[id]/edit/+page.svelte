<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import {
		ArrowLeft,
		Undo2,
		Redo2,
		Type as TypeIcon,
		Square,
		Tag as TagIcon,
		Image as ImageIcon,
		Trash2,
		Eye,
		EyeOff,
		Copy,
		Keyboard,
		Sliders,
		ExternalLink,
		AlertTriangle as AlertTriangleIcon
	} from '@lucide/svelte';
	import CanvasEditor from '$lib/components/editor/Canvas.svelte';
	import LayerPanel from '$lib/components/editor/LayerPanel.svelte';
	import PropertyPanel from '$lib/components/editor/PropertyPanel.svelte';
	import PublishModal from '$lib/components/editor/PublishModal.svelte';
	import ParamsPanel from '$lib/components/editor/ParamsPanel.svelte';
	import MobileBanner from '$lib/components/editor/MobileBanner.svelte';
	import CanvasSettingsModal, {
		type CanvasSettingsPatch
	} from '$lib/components/editor/CanvasSettingsModal.svelte';
	import AddImageModal from '$lib/components/editor/AddImageModal.svelte';
	import ShortcutsCheatsheetModal from '$lib/components/editor/ShortcutsCheatsheetModal.svelte';
	import {
		editorState,
		markClean,
		setHydrationComplete
	} from '$lib/components/editor/state.svelte';
	import {
		historyState,
		saveSnapshot,
		resetHistory,
		beginSuppressSnapshots,
		endSuppressSnapshots
	} from '$lib/components/editor/history.svelte';
	import { EDITOR_TO_OBJECT_PROPS } from '$lib/components/editor/serialize';
	import {
		collectAssetIdsFromTemplate,
		fetchAssetUrlsByIds,
		rewriteAssetRefsForEditor,
		serializeAssetLinks
	} from '$lib/components/editor/asset-link';
	import { toast } from '$lib/stores/toast.svelte';
	import { copyToClipboard } from '$lib/share-clipboard';
	import { ConfirmDialog } from '$lib/components/ui';
	import { fontStore } from '$lib/stores/fonts.svelte';

	/** Accepted by /api/upload for image uploads. Must stay in sync with
	 * server-side ALLOWED_IMAGE_TYPES. */
	const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
	/** Must stay in sync with MAX_IMAGE_SIZE on the server. */
	const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

	let { data } = $props();

	// Local copy so the Publish modal can update it after a successful publish/unpublish
	// without a full page reload. Resynced whenever the loaded canvas changes so that
	// client-side navigation between different /canvas/[id]/edit records does not
	// keep showing the prior canvas's publish state. `untrack` on the initial read
	// silences svelte-check's "state_referenced_locally" warning — the resync effect
	// below is what actually keeps this in step with `data`.
	let isPublished = $state(untrack(() => data.canvas.published));
	// Local mirror of the canvas slug so the Publish modal's rename UI
	// (TASK-98) can update the displayed slug across the editor without
	// a full page reload. Resynced when the loaded canvas changes.
	let canvasSlug = $state(untrack(() => data.canvas.slug));
	let canvasScopedSyncId = $state(untrack(() => data.canvas.id));
	$effect(() => {
		if (data.canvas.id !== canvasScopedSyncId) {
			canvasScopedSyncId = data.canvas.id;
			// Resync publish state for the newly loaded canvas.
			isPublished = data.canvas.published;
			canvasSlug = data.canvas.slug;
			// Resync dimensions + background for the new canvas.
			canvasWidth = data.canvas.width;
			canvasHeight = data.canvas.height;
			canvasBgType = data.canvas.backgroundType as 'color' | 'image';
			canvasBgValue = data.canvas.backgroundValue;
			showSettingsModal = false;
			// Switch zoom mode back to auto-fit for the newly loaded canvas.
			// CanvasEditor is reused across SPA navigations within
			// /canvas/[id]/edit, so `setFabricCanvas()` (which also resets
			// zoom) doesn't fire on param changes. Canvas.svelte's $effect
			// watches `zoomMode` so this 'manual → fit' write triggers a
			// refit when dimensions change OR stay the same. We DON'T
			// pre-write zoom to 1 here — that would be visible as a flash
			// to 100% before the effect re-fits, and (Codex round 3 P2)
			// would leave a same-dimensions fit→fit switch stuck at 100%
			// because no other dep changes to retrigger the effect.
			// Letting applyFitIfTracking compute the right scale keeps the
			// fit-correct invariant: editorState.zoom always matches what
			// fit + current dims says, modulo manual overrides.
			editorState.zoomMode = 'fit';
			// Reset save-failure state so a stale failure from canvas A doesn't
			// bleed into canvas B (wrong red pill + wrong retry toast).
			lastSaveFailed = false;
			if (failedToastId) {
				toast.dismiss(failedToastId);
				failedToastId = null;
			}
			// Clear isSaving. If a save was in flight for canvas A when the user
			// switched, the stale-guard in save() already ignores the returning
			// response for state purposes, but isSaving itself never gets cleared
			// there (intentional — so a late A-response doesn't clobber a B-save
			// in progress). The newly loaded canvas starts from a clean slate.
			isSaving = false;
			// Drop any Test Parameter values entered while previewing canvas A
			// so they don't leak into canvas B's preview when the user opens it.
			// Also close the preview panel if it was open, because
			// collectBoundParams() runs only on togglePreview(); leaving preview
			// open after the switch would show canvas A's binding list (or
			// a spurious "no bindings" state) alongside canvas B's render.
			// Reopening gives the user a fresh, correctly-populated panel.
			testParams = Object.create(null);
			boundParams = [];
			previewQuery = '';
			if (showPreview) {
				showPreview = false;
				previewUrl = '';
				clearTimeout(previewDebounce);
			}
			// Any in-flight openPublishModal() for canvas A has been orphaned
			// by the switch; make sure we don't leave the button stuck in
			// "Loading…" for canvas B.
			openingPublish = false;
			showPublishModal = false;
			publishBindings = [];
			publishBindingsStale = false;
			// Close the params panel too — it has its own canvasId-keyed
			// fetch but rendering A's stale schema rows briefly while
			// canvas B's render races in is jarring. Codex round 1 P1.
			showParamsPanel = false;
		}
	});
	let showPublishModal = $state(false);
	let openingPublish = $state(false);
	let duplicating = $state(false);
	// Params modal (TASK-105). Surfaces the same per-canvas schema editor
	// the publish modal hosts, but accessible directly from the editor —
	// so authors don't have to publish → edit-types → republish to fix a
	// wrong type or default. Distinct from showPublishModal so the user
	// can have either open without losing their place.
	let showParamsPanel = $state(false);

	/**
	 * Duplicate the current canvas via POST /api/canvas/[id]/duplicate and
	 * navigate to the new canvas's editor. Flushes any pending save first
	 * so the duplicate captures the user's latest edits, not the
	 * server-persisted snapshot from before the last in-flight change.
	 *
	 * Sets `bypassNavigationGuard = true` before goto so the user isn't
	 * trapped in the leave-without-saving dialog after a successful save —
	 * the save above already flushed isDirty, but the guard also fires on
	 * isUploading/isInsertingImage which we cannot safely flush here.
	 * Those windows are short, so we just skip duplication when they're
	 * active (rare in practice and obvious from the disabled button).
	 */
	async function duplicateInEditor() {
		if (duplicating) return;
		if (isUploading || isInsertingImage) {
			toast.error('Wait for the in-progress upload to finish, then try again.');
			return;
		}
		duplicating = true;
		try {
			// Flush any in-flight save first so a save() call here
			// doesn't no-op due to isSaving=true and miss the latest edits.
			await waitForSave();
			// Then loop save while still dirty. A single save() can return
			// true (PATCH succeeded) without markClean(), if editGeneration
			// changed during the request — meaning more edits arrived
			// during the save window. Re-saving picks them up. The publish
			// flow does the equivalent via waitForSave() + save().
			if (editorState.isDirty) {
				const ok = await save();
				if (!ok || editorState.isDirty) {
					toast.error('Could not save before duplicating. Try again.');
					return;
				}
			}
			const res = await fetch(`/api/canvas/${data.canvas.id}/duplicate`, { method: 'POST' });
			if (!res.ok) {
				toast.error('Could not duplicate this canvas. Try again.');
				return;
			}
			const created = (await res.json()) as { id: string };
			bypassNavigationGuard = true;
			await goto(`/canvas/${created.id}/edit`);
		} catch {
			toast.error('Could not duplicate this canvas. Check your connection and try again.');
		} finally {
			duplicating = false;
		}
	}
	/** Snapshot of the current bindings in the format PublishModal expects.
	 * Only refreshed after any pending edits are persisted — the public
	 * renderer reads templateJson from the DB, so if we snapshotted from live
	 * Fabric state while the canvas was dirty, the "Using this template"
	 * table and example URLs could describe bindings that aren't yet live. */
	let publishBindings = $state<{ name: string; default: string; sourceLabel: string }[]>([]);
	/** True when we opened the modal without being able to persist pending
	 * edits. Triggers a warning in the docs section but still lets the user
	 * reach the Unpublish button (which doesn't depend on template state). */
	let publishBindingsStale = $state(false);

	async function openPublishModal() {
		if (openingPublish) return;
		openingPublish = true;
		// Pin canvas id at click time. If the user switches to a different
		// /canvas/[id]/edit — or leaves the editor entirely — while we're
		// awaiting hydration/save, we must not apply UI state
		// (publishBindings / showPublishModal / toasts) for the wrong canvas.
		// Same rationale as the stale-guard in save().
		const originCanvasId = data.canvas.id;
		const isStale = () => !isMounted || data.canvas.id !== originCanvasId;
		try {
			// Block clicks that land before loadFromJSON() finishes. Without this,
			// collectBoundParams() could walk a cleared-but-not-yet-repopulated
			// Fabric canvas and snapshot an empty bindings list.
			const hydrated = await waitForHydration();
			if (isStale()) return;
			if (!hydrated) {
				toast.error('Canvas is still loading — try Publish again in a moment.');
				return;
			}

			// Bounded wait: save() uses fetch() with no timeout, so a stalled
			// backend could otherwise freeze this flow indefinitely and block
			// the only in-UI path to Unpublish. If we time out, continue with
			// persistOk=false so the modal still opens (with a staleness
			// warning) and the user can still reach Unpublish.
			const PUBLISH_SAVE_TIMEOUT_MS = 8000;
			const waitedOk = await waitForSave(PUBLISH_SAVE_TIMEOUT_MS);
			if (isStale()) return;

			// save() skips markClean() when edits land *during* the PATCH (to
			// avoid clobbering work). A single loop iteration could therefore
			// return true and still leave us dirty. Loop a few times so that a
			// stable clean state — matching what the public renderer will
			// actually serve — precedes the binding snapshot. If save fails
			// (or dirt persists) we still open the modal — the user may have
			// clicked solely to hit Unpublish, which does not depend on
			// template state. The modal shows a staleness warning instead.
			const MAX_PERSIST_ATTEMPTS = 3;
			let persistOk = waitedOk;
			if (waitedOk) {
				for (let i = 0; i < MAX_PERSIST_ATTEMPTS && editorState.isDirty; i++) {
					const saved = await save();
					if (isStale()) return;
					if (!saved) {
						persistOk = false;
						break;
					}
				}
			}
			if (isStale()) return;
			publishBindingsStale = !persistOk || editorState.isDirty;
			publishBindings = collectBoundParams().map((b) => ({
				name: b.name,
				default: b.default,
				sourceLabel: b.sampleLabel
			}));
			showPublishModal = true;
		} finally {
			// Clear the loading flag only if we're still on the originating
			// canvas — otherwise the canvas-switch resync effect owns state.
			if (!isStale()) openingPublish = false;
		}
	}

	let editorRef: ReturnType<typeof CanvasEditor> | undefined = $state();
	let isSaving = $state(false);
	/** True when the last save attempt errored out. Cleared on the next
	 * successful save. Drives the persistent "Save failed" indicator and
	 * the sticky error toast. */
	let lastSaveFailed = $state(false);
	/** ID of the sticky error toast so we can dismiss it when the user
	 * either retries successfully or dismisses it manually. */
	let failedToastId = $state<string | null>(null);
	let showPreview = $state(false);
	let previewUrl = $state('');

	/** Derived UI state for the Save button. The button doubles as the
	 * save-status indicator — there's no separate pill (BT-160).
	 *
	 * Priority order: saving > failed > dirty > saved. `isSaving` outranks
	 * `lastSaveFailed` so a retry after a failure shows "Saving…"
	 * (disabled) instead of leaving the button on "Retry save" (enabled)
	 * while the PATCH is in-flight — without that order the user could
	 * fire a second click that races the first request. `lastSaveFailed`
	 * is intentionally only cleared on a successful save, so the failed
	 * state re-appears if the retry itself errors out. */
	type SaveButtonState = 'saved' | 'dirty' | 'saving' | 'failed';
	let saveButtonState: SaveButtonState = $derived.by(() => {
		if (isSaving) return 'saving';
		if (lastSaveFailed) return 'failed';
		if (editorState.isDirty) return 'dirty';
		return 'saved';
	});

	function saveButtonLabel(s: SaveButtonState): string {
		switch (s) {
			case 'saving':
				return 'Saving…';
			case 'failed':
				return 'Retry save';
			case 'saved':
				return 'Saved';
			case 'dirty':
				return 'Save';
		}
	}

	// Locally-tracked canvas dimensions/background so the settings modal can
	// update them live without a full route reload. Synced to `data` in the
	// canvas-switch effect. `untrack` on the initial read mirrors the
	// isPublished pattern and silences svelte-check's state_referenced_locally.
	let canvasWidth = $state(untrack(() => data.canvas.width));
	let canvasHeight = $state(untrack(() => data.canvas.height));
	let canvasBgType = $state<'color' | 'image'>(
		untrack(() => data.canvas.backgroundType as 'color' | 'image')
	);
	let canvasBgValue = $state(untrack(() => data.canvas.backgroundValue));
	let showSettingsModal = $state(false);

	let backgroundColor = $derived(canvasBgType === 'color' ? canvasBgValue : '#ffffff');

	// Load template JSON once editorState.fabricCanvas is ready — track by canvas ID
	// Track which hydration is current — incremented on every load to
	// invalidate stale completions from overlapping navigations
	let loadedCanvasId = $state('');
	let hydrationToken = $state(0);
	/** True once loadFromJSON(...) has completed for the currently-loaded
	 * canvas id. Serialized edits (save, publish-docs snapshot) must wait
	 * for this to avoid operating on a cleared-but-not-yet-populated
	 * Fabric canvas. */
	let hydrationComplete = $state(false);
	$effect(() => {
		if (editorState.fabricCanvas && loadedCanvasId !== data.canvas.id) {
			loadedCanvasId = data.canvas.id;
			hydrationComplete = false;
			// Mirror onto the shared editorState so panels (LayerPanel's
			// empty-state gate) can read the same signal without prop-
			// drilling. Re-flipped to true in every completion path below.
			setHydrationComplete(false);
			const thisToken = ++hydrationToken;
			const canvas = editorState.fabricCanvas;

			// Suppress snapshots before clearing to prevent object:removed
			// events from marking dirty on the empty-canvas transition.
			beginSuppressSnapshots();

			// Clear canvas and reset state before loading new content
			canvas.clear();
			// Restore background after clear() wipes it
			canvas.backgroundColor = backgroundColor;
			canvas.renderAll();
			resetHistory();
			// Reset dirty flag so the post-clear state isn't reported as
			// unsaved edits by the navigation guard or the Save button.
			markClean();

			if (data.canvas.templateJson) {
				// Resolve asset:// references in a fresh deep clone so the
				// loaded canvas isn't mutated against the data prop. The
				// resolver replaces each `asset://{id}` in src / fallbackSrc
				// / iconImage with the public URL Fabric needs to fetch, and
				// stamps the id onto the layer (srcAssetId etc.) so the save
				// path can reverse the rewrite.
				const json = JSON.parse(JSON.stringify(data.canvas.templateJson)) as Record<
					string,
					unknown
				>;
				const ids = collectAssetIdsFromTemplate(
					json as { objects?: Array<Record<string, unknown>> }
				);
				const loadFromHydratedJson = (hydratedJson: typeof json) => {
					canvas
						.loadFromJSON(hydratedJson)
						.then(() => {
							if (hydrationToken !== thisToken) return;
							// Fabric v7's loadFromJSON internally calls canvas.clear()
							// (which resets backgroundColor to '') and then re-sets the
							// canvas from the JSON. Our templateJson carries
							// {version, objects} only — background lives on the canvas
							// row (data.canvas.backgroundType/Value), not in the JSON
							// — so the pre-load assignment above gets wiped and nothing
							// restores it. Re-apply here before render so the editor
							// matches the gallery preview + the rendered output.
							canvas.backgroundColor = backgroundColor;
							canvas.renderAll();
						})
						.finally(() => {
							// Only end suppression if this is still the active hydration
							if (hydrationToken !== thisToken) return;
							endSuppressSnapshots();
							saveSnapshot(canvas);
							// Fabric's loadFromJSON fires an `object:added` per layer
							// (Canvas.svelte wires it to markDirty), so a non-empty
							// canvas finishes hydration with editorState.isDirty=true
							// — i.e. no user input but the Save button reads 'dirty'
							// and the beforeNavigate guard would trap the user on
							// first load. Autosave used to mask this by PATCHing
							// 2s later and clearing dirty in markClean(); with
							// manual-only saves (BT-160) we have to do it here.
							markClean();
							hydrationComplete = true;
							setHydrationComplete(true);
						});
				};
				if (ids.length === 0) {
					loadFromHydratedJson(json);
				} else {
					fetchAssetUrlsByIds(ids).then((idToUrl) => {
						if (hydrationToken !== thisToken) return;
						rewriteAssetRefsForEditor(
							json as { objects?: Array<Record<string, unknown>> },
							idToUrl
						);
						loadFromHydratedJson(json);
					});
				}
			} else {
				// Empty canvas — end suppression and save initial blank snapshot
				endSuppressSnapshots();
				saveSnapshot(canvas);
				hydrationComplete = true;
				setHydrationComplete(true);
			}
		}
	});

	async function waitForHydration(timeoutMs = 5000): Promise<boolean> {
		const start = Date.now();
		while (!hydrationComplete) {
			if (Date.now() - start > timeoutMs) return false;
			await new Promise((r) => setTimeout(r, 50));
		}
		return true;
	}

	// Load user fonts and register them with the browser's FontFace API so
	// the Fabric canvas can render text in custom families. Bundled fonts
	// are usable immediately; user fonts unlock the dropdown + canvas
	// rendering once they've loaded. We force a Fabric repaint after the
	// fetch completes so any text using a still-loading family re-measures
	// against the now-loaded glyphs (otherwise the canvas keeps fallback
	// metrics from the initial paint).
	//
	// Wrap in `untrack` so reads of fontStore's internal $state inside
	// loadUserFonts don't subscribe this effect — without it, the
	// in-function `if (loadingUserFonts) return` guard becomes a tracked
	// read, every state flip re-runs the effect, and the page never
	// reaches networkidle.
	$effect(() => {
		untrack(() => {
			void fontStore.loadUserFonts().then(() => {
				editorState.fabricCanvas?.requestRenderAll();
			});
		});
	});

	// Saving is fully manual (BT-160). The user persists via the Save
	// button or Cmd/Ctrl+S; the beforeNavigate guard catches unsaved work
	// on route changes, and the Duplicate / Preview / Publish flows each
	// flush via save() before they act.

	let showCheatsheet = $state(false);

	/**
	 * True when the keystroke originated from a focused form control or
	 * Fabric IText editing — those own their own arrow / Backspace / etc.
	 * handling and our shortcuts must NOT preempt them. Excludes the
	 * canvas wrapper element (role="application") because it's a noop for
	 * typing — actively tabbing to it should not dampen our shortcuts.
	 */
	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
		if (target.isContentEditable) return true;
		return false;
	}

	/** True when a Fabric IText on the canvas is in editing mode. The
	 *  global keydown listener routes via `window`, so a `?` keystroke
	 *  while the user is typing into a canvas text object would otherwise
	 *  open the cheatsheet instead of inserting the character. The
	 *  isTypingTarget() check above only catches DOM text inputs;
	 *  Fabric's IText has its own internal text buffer, not a DOM input. */
	function isCanvasTextEditing(): boolean {
		const active = editorState.fabricCanvas?.getActiveObject();
		if (!active) return false;
		// Fabric's IText sets isEditing while the cursor is active.
		return active.type === 'i-text' && (active as { isEditing?: boolean }).isEditing === true;
	}

	// Editor-wide keyboard shortcuts. Lives on `window` because the canvas
	// wrapper only gets keydowns when focused, and the property panel can
	// steal focus mid-edit. Filtering via `isTypingTarget` keeps the
	// shortcuts silent while the user is typing in the panel.
	$effect(() => {
		function onKey(e: KeyboardEvent) {
			// If a closer handler (e.g. Canvas.svelte's wrapper-level
			// keydown for delete/undo/redo) already handled this keystroke
			// and called preventDefault, don't re-fire. Without this, with
			// canvas-wrapper focus a single Cmd+Z would undo twice.
			if (e.defaultPrevented) return;
			// Cmd/Ctrl+S handled BEFORE the typing-target / cheatsheet
			// guards so it always preempts the browser's "Save page"
			// dialog — even while the user is typing in a panel input or
			// the cheatsheet is open. Save is a global action that
			// shouldn't be silently dropped just because focus drifted.
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
				e.preventDefault();
				// Blur the active element so any property-panel input that
				// commits on `change` (X/Y/W/H/color, fontSize, etc.) flushes
				// its pending value into Fabric before save() serializes the
				// canvas. Without this, Cmd+S immediately after typing a new
				// X value would persist the *previous* X.
				if (document.activeElement instanceof HTMLElement) {
					document.activeElement.blur();
				}
				void (async () => {
					if (await save()) toast.success('Saved');
				})();
				return;
			}
			if (isTypingTarget(e.target)) return;
			if (isCanvasTextEditing()) return;
			// Block all shortcuts while the cheatsheet (or any future
			// editor-owned modal) is open. A <dialog> keydown target isn't
			// a typing target, so without this an arrow/Cmd+D/Cmd+bracket
			// pressed over the modal would still mutate the canvas behind
			// it. The Modal handles its own Escape close, so this guard
			// doesn't trap the user.
			if (showCheatsheet) return;
			// `?` opens the cheatsheet. Modal Esc closes itself, so we don't
			// also need a global toggle.
			if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
				e.preventDefault();
				showCheatsheet = true;
				return;
			}
			// Escape clears the active selection on the canvas.
			if (e.key === 'Escape' && !showCheatsheet) {
				editorRef?.deselectAll();
				return;
			}
			// Arrow nudge — 1px (10px with Shift). Skip when no object is
			// selected; nudgeSelected itself short-circuits, but skipping
			// here lets the browser handle arrow scrolling on a no-selection
			// canvas, which feels right.
			if (
				e.key === 'ArrowUp' ||
				e.key === 'ArrowDown' ||
				e.key === 'ArrowLeft' ||
				e.key === 'ArrowRight'
			) {
				if (!editorState.fabricCanvas?.getActiveObject()) return;
				const step = e.shiftKey ? 10 : 1;
				const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
				const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
				e.preventDefault();
				editorRef?.nudgeSelected(dx, dy);
				return;
			}
			// Align (Alt+Shift+L/C/R/T/M/B) and Distribute (Alt+Shift+H/V)
			// — TASK-133. Alt+Shift was chosen because it's unbound on
			// Chrome/Firefox/Safari across macOS/Windows/Linux and doesn't
			// collide with existing editor shortcuts (Cmd/Ctrl variants).
			//
			// Use `e.code` not `e.key` here: macOS's Option (Alt) key
			// transforms the printed character (Option+L renders `¬`,
			// not "l"), so reading `e.key` would miss the shortcut on
			// every Mac. `e.code` reports the physical key regardless
			// of modifier transforms.
			//
			// Selection gating mirrors the toolbar's:
			//   - align actions require 2+ selected objects
			//   - distribute actions require 3+ selected objects
			// Below those thresholds the shortcut still consumes the
			// keystroke (preventDefault) only when we have a match —
			// otherwise it falls through so the browser keeps any
			// native binding.
			if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
				const selected = editorState.activeObjects.length;
				const alignMap: Record<
					string,
					'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom'
				> = {
					KeyL: 'left',
					KeyC: 'center-h',
					KeyR: 'right',
					KeyT: 'top',
					KeyM: 'center-v',
					KeyB: 'bottom'
				};
				const distributeMap: Record<string, 'h' | 'v'> = {
					KeyH: 'h',
					KeyV: 'v'
				};
				const alignDir = alignMap[e.code];
				if (alignDir) {
					if (selected >= 2) {
						e.preventDefault();
						editorRef?.alignSelected(alignDir);
					}
					return;
				}
				const distributeAxis = distributeMap[e.code];
				if (distributeAxis) {
					if (selected >= 3) {
						e.preventDefault();
						editorRef?.distributeSelected(distributeAxis);
					}
					return;
				}
			}
			const mod = e.metaKey || e.ctrlKey;
			if (!mod) return;
			const key = e.key.toLowerCase();
			// (Cmd/Ctrl+S handled above the typing-target guard.)
			// Undo / redo. Mirrors the canvas-wrapper-level handler so the
			// shortcuts still work when focus has drifted to the toolbar
			// or any other non-typing element. Cheatsheet documents these,
			// so they must be reachable globally.
			if (key === 'z' && e.shiftKey) {
				e.preventDefault();
				editorRef?.redoAction();
				return;
			}
			if (key === 'z' && !e.shiftKey) {
				e.preventDefault();
				editorRef?.undoAction();
				return;
			}
			// Duplicate (Cmd/Ctrl+D).
			if (key === 'd' && !e.shiftKey) {
				e.preventDefault();
				void editorRef?.duplicateSelected();
				return;
			}
			// Layer order — Cmd/Ctrl+] forward, +[ backward; +Shift = front/back.
			if (e.key === ']') {
				e.preventDefault();
				if (e.shiftKey) editorRef?.bringSelectedToFront();
				else editorRef?.bringSelectedForward();
				return;
			}
			if (e.key === '[') {
				e.preventDefault();
				if (e.shiftKey) editorRef?.sendSelectedToBack();
				else editorRef?.sendSelectedBackward();
				return;
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	// beforeunload warning: protects users from losing work when they close the
	// tab, reload, or navigate to an *external* URL while the editor has unsaved
	// edits, an in-flight save, or a queued/active upload. Modern browsers
	// render their generic "Leave site?" dialog; legacy engines honor returnValue.
	$effect(() => {
		function onBeforeUnload(e: BeforeUnloadEvent) {
			if (hasPendingWork()) {
				e.preventDefault();
				e.returnValue = '';
			}
		}
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => window.removeEventListener('beforeunload', onBeforeUnload);
	});

	// SvelteKit client-side navigation guard. `beforeunload` alone doesn't fire
	// on SPA transitions (e.g. clicking the Dashboard link in the toolbar), so
	// without this the editor would unmount silently and pending work would be
	// lost. We cancel the navigation and show a styled confirm dialog; if the
	// user confirms, we set a one-shot bypass flag and re-issue the goto.
	let pendingNavigationHref = $state<string | null>(null);
	/** True when the blocked destination isn't an app-owned SvelteKit route
	 * (route.id === null) — e.g. external link, non-SvelteKit URL, or
	 * browser-back to an external referrer. Those can't be re-issued via
	 * goto(); they need window.location. */
	let pendingNavigationIsExternal = false;
	let bypassNavigationGuard = false;

	function hasPendingWork(): boolean {
		return editorState.isDirty || isSaving || isUploading || isInsertingImage;
	}

	beforeNavigate((nav) => {
		if (bypassNavigationGuard) {
			bypassNavigationGuard = false;
			return;
		}
		if (!hasPendingWork()) return;
		const targetHref = nav.to?.url.href;
		if (!targetHref) return;
		pendingNavigationHref = targetHref;
		pendingNavigationIsExternal = nav.to?.route?.id == null;
		nav.cancel();
	});

	function confirmLeave() {
		const href = pendingNavigationHref;
		const external = pendingNavigationIsExternal;
		pendingNavigationHref = null;
		pendingNavigationIsExternal = false;
		if (!href) return;
		bypassNavigationGuard = true;
		if (external) {
			// SvelteKit's goto() only supports app-owned routes. For external or
			// non-SvelteKit destinations we must use window.location, otherwise
			// confirming the dialog throws and the user is trapped.
			window.location.href = href;
		} else {
			goto(href);
		}
	}

	function cancelLeave() {
		pendingNavigationHref = null;
		pendingNavigationIsExternal = false;
	}

	/** Flips false the moment the editor component starts tearing down.
	 * Used to gate late save callbacks — if a save's response arrives after
	 * the user has left /canvas/[id]/edit entirely (data.canvas.id didn't
	 * change, but the component is gone), we must not run handlers that
	 * emit UI (e.g. global retry toast) or touch torn-down state. */
	let isMounted = true;

	// Dismiss any lingering failure toast when the editor unmounts and mark
	// ourselves unmounted so in-flight saves ignore late responses. Without
	// this cleanup: (1) a sticky Retry toast leaks onto unrelated routes,
	// and (2) its Retry action would call save() on a torn-down component.
	$effect(() => {
		return () => {
			isMounted = false;
			if (failedToastId) {
				toast.dismiss(failedToastId);
				failedToastId = null;
			}
		};
	});

	function handleSaveFailure() {
		lastSaveFailed = true;
		// If a previous failure toast is still visible, let it continue to
		// represent the current state instead of stacking a new one.
		if (failedToastId && toast.items.some((t) => t.id === failedToastId)) return;
		failedToastId = toast.error('Could not save your canvas.', {
			action: {
				label: 'Retry',
				onClick: () => {
					failedToastId = null;
					void save();
				}
			}
		});
	}

	function handleSaveSuccess() {
		lastSaveFailed = false;
		if (failedToastId) {
			toast.dismiss(failedToastId);
			failedToastId = null;
		}
	}

	async function save(): Promise<boolean> {
		if (!editorState.fabricCanvas || isSaving) return false;
		isSaving = true;
		// Capture generation before save — only mark clean if no new edits during save
		const genBeforeSave = editorState.editGeneration;
		// Pin the canvas id at request start. If the user navigates to a
		// different /canvas/[id]/edit before the response arrives, we must
		// not flip the new canvas's save-status based on the stale A-response.
		// We also gate on isMounted so a late response that lands after the
		// user has left /canvas/[id]/edit entirely (different route, not a
		// sibling canvas) doesn't leak a retry toast onto unrelated pages.
		const originCanvasId = data.canvas.id;
		const isStale = () => !isMounted || data.canvas.id !== originCanvasId;
		try {
			const json = editorState.fabricCanvas.toObject([...EDITOR_TO_OBJECT_PROPS]);
			// Persisted JSON references library assets via `asset://{id}`
			// (TASK-116) so the canvas survives storage migrations and
			// asset-URL changes. Layers with a tracked *AssetId get their
			// URL field rewritten back to the asset:// form here.
			serializeAssetLinks(json);
			const res = await fetch(`/api/canvas/${originCanvasId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ templateJson: json })
			});
			if (isStale()) return false;
			if (!res.ok) {
				handleSaveFailure();
				return false;
			}
			// Only mark clean if no edits happened during the save
			if (editorState.editGeneration === genBeforeSave) {
				markClean();
			}
			handleSaveSuccess();
			return true;
		} catch {
			if (isStale()) return false;
			handleSaveFailure();
			return false;
		} finally {
			// Only clear isSaving for the originating canvas; if we navigated
			// away, the resync effect already handled teardown of the new
			// canvas's state, and setting isSaving here would be wrong for it
			// (though harmless since save() early-returns if already saving).
			if (!isStale()) isSaving = false;
		}
	}

	let isUploading = $state(false);
	/** True while a successfully-uploaded or library-picked image is being
	 * loaded into Fabric (FabricImage.fromURL → addImageFromUrl). The
	 * upload-state guard alone misses this window: the modal flips
	 * isUploading=false the moment the fetch settles, but the actual
	 * Fabric insert is still pending. Without this flag, a fast nav after
	 * selecting from the library — or right at the moment a fresh upload
	 * resolves — can unmount the editor mid-insert. */
	let isInsertingImage = $state(false);
	/** Toggles the Upload/Library tabbed picker that replaced the bare
	 * file-input button on the toolbar. Drag-drop onto the canvas still
	 * uses the unmodaled queueUpload() path below — we don't want a drop
	 * to pop a modal in front of where the user just dropped. */
	let showAddImageModal = $state(false);
	let isDraggingFile = $state(false);
	/** Counts nested dragenter/dragleave events so the overlay only clears when
	 * the drag leaves the outer container, not when it moves between children. */
	let dragCounter = 0;
	/** Chain of pending uploads. Each enqueued file awaits the previous one, so
	 * concurrent drops/pickers never stack large parallel POSTs even across
	 * multiple drop events. */
	let uploadChain: Promise<void> = Promise.resolve();

	function queueUpload(file: File) {
		// Pin the canvas id at *enqueue* time, not when the queued callback
		// eventually runs. Otherwise a batch dropped on canvas A that's still
		// waiting in the chain would read the (by-then current) canvas B when
		// it finally starts.
		const originCanvasId = data.canvas.id;
		uploadChain = uploadChain
			.then(() => uploadAndInsertImage(file, originCanvasId))
			.catch(() => {});
		return uploadChain;
	}

	/** Insert a previously-uploaded asset (from the From-library tab) into
	 *  the canvas. Mirrors the post-upload tail of `uploadAndInsertImage`
	 *  but skips the upload itself — the URL is already in storage.
	 *
	 *  Wrapping the await in isInsertingImage=true/false keeps
	 *  hasPendingWork() truthful during the FabricImage.fromURL window so
	 *  the navigation guard fires if the user clicks away mid-insert. */
	async function insertExistingAsset(url: string, originCanvasId: string, assetId?: string) {
		if (data.canvas.id !== originCanvasId) {
			toast.info('Image was not added — you switched canvases.');
			return;
		}
		if (!editorRef) {
			toast.error('Editor was unavailable — refresh and try again.');
			return;
		}
		isInsertingImage = true;
		try {
			const inserted = await editorRef.addImageFromUrl(url, assetId);
			if (inserted) {
				toast.success('Image added');
			} else {
				toast.error('Could not add image — try again.');
			}
		} catch (err) {
			// FabricImage.fromURL can reject on broken/missing assets, CORS
			// failures, or decode errors. Surface a user-visible error
			// instead of letting it become an unhandled rejection.
			console.error('[editor] insertExistingAsset failed', err);
			if (data.canvas.id === originCanvasId) {
				toast.error('Could not load that image — it may be broken or unavailable.');
			}
		} finally {
			// Only clear the flag if we're still on the originating canvas.
			// If the user switched canvases mid-insert, the resync effect
			// has already taken ownership of editor state.
			if (data.canvas.id === originCanvasId) isInsertingImage = false;
		}
	}

	/** Bridge for AddImageModal's onSelect — runs whether the URL came from
	 *  a fresh upload (modal handled upload itself) or a library pick. We
	 *  don't reuse queueUpload() here because (a) there's nothing to upload,
	 *  and (b) serializing inserts behind the upload chain would needlessly
	 *  block the library-tab insertion on any in-flight drag-drop upload. */
	function onAddImageModalSelect(url: string, assetId?: string) {
		const originCanvasId = data.canvas.id;
		showAddImageModal = false;
		void insertExistingAsset(url, originCanvasId, assetId);
	}

	async function uploadAndInsertImage(file: File, originCanvasId: string) {
		if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
			toast.error(`"${file.name}" is not a supported image. Use PNG, JPEG, WebP, or SVG.`);
			return;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			toast.error(`"${file.name}" is larger than 5MB. Please use a smaller image.`);
			return;
		}

		isUploading = true;
		const uploadingId = toast.info(`Uploading "${file.name}"…`, { duration: 0 });
		try {
			const formData = new FormData();
			formData.append('file', file);
			const res = await fetch('/api/upload', { method: 'POST', body: formData });
			if (!res.ok) {
				let detail = '';
				try {
					const body = await res.json();
					detail = typeof body?.message === 'string' ? ` — ${body.message}` : '';
				} catch {
					// ignore — server returned a non-JSON error
				}
				toast.error(`Upload failed${detail}`);
				return;
			}
			// `id` (TASK-116) — drag-drop and direct uploads are library-
			// backed too, so stamp the assetId on insertion to drive the
			// save-time `asset://` rewrite. Pre-existing /api/upload
			// responses don't include `id` so we tolerate it being absent.
			const { url, id: assetId } = (await res.json()) as {
				url: string;
				id?: string;
			};
			if (data.canvas.id !== originCanvasId) {
				// User switched canvases during the upload. The asset is saved to
				// their library but we don't silently inject it into the new canvas.
				toast.info(`"${file.name}" was uploaded but not added — you switched canvases.`);
				return;
			}
			if (!editorRef) {
				// Editor may be unavailable if the user navigated away mid-upload.
				// The upload still succeeded server-side; surface that honestly.
				toast.error('Image uploaded but editor was unavailable — refresh and try again.');
				return;
			}
			const inserted = await editorRef.addImageFromUrl(url, assetId);
			if (inserted) {
				toast.success('Image added');
			} else {
				// addImageFromUrl returns false when the Fabric canvas isn't ready
				// (e.g. mount/teardown race). Don't lie about a successful insert.
				toast.error('Image uploaded but could not be added — try again.');
			}
		} catch {
			toast.error('Upload failed. Check your connection and try again.');
		} finally {
			toast.dismiss(uploadingId);
			isUploading = false;
		}
	}

	function hasFileDrag(e: DragEvent): boolean {
		return Array.from(e.dataTransfer?.types ?? []).includes('Files');
	}

	// While the editor is mounted, swallow any file drag-drops that miss the
	// canvas container (toolbar, side panels, empty space). Without this guard,
	// a stray drop would cause the browser to navigate to the dropped file,
	// tearing the user out of the editor and potentially losing unsaved work.
	$effect(() => {
		function block(e: DragEvent) {
			if (hasFileDrag(e)) e.preventDefault();
		}
		window.addEventListener('dragover', block);
		window.addEventListener('drop', block);
		return () => {
			window.removeEventListener('dragover', block);
			window.removeEventListener('drop', block);
		};
	});

	function onDragEnter(e: DragEvent) {
		if (!hasFileDrag(e)) return;
		e.preventDefault();
		dragCounter++;
		isDraggingFile = true;
	}

	function onDragOver(e: DragEvent) {
		if (!hasFileDrag(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(e: DragEvent) {
		if (!hasFileDrag(e)) return;
		e.preventDefault();
		dragCounter = Math.max(0, dragCounter - 1);
		if (dragCounter === 0) isDraggingFile = false;
	}

	function onDrop(e: DragEvent) {
		if (!hasFileDrag(e)) return;
		e.preventDefault();
		dragCounter = 0;
		isDraggingFile = false;
		const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
			f.type.startsWith('image/')
		);
		if (files.length === 0) {
			toast.error('Drop an image file (PNG, JPEG, WebP, or SVG).');
			return;
		}
		// Route through the shared upload chain so a second drop (or file-picker
		// upload) initiated while the first batch is still in flight doesn't
		// stack parallel requests — they queue end-to-end instead.
		for (const file of files) {
			queueUpload(file);
		}
	}

	/** Wait for any in-flight save to finish, with an optional timeout. Returns
	 * true when isSaving is clear, false when the timeout expired first.
	 * A bounded wait is important for flows (like openPublishModal) that must
	 * not block the UI indefinitely if the backend or network hangs — the
	 * caller can surface a stale-state warning instead of leaving the button
	 * stuck on "Loading…" forever. */
	async function waitForSave(timeoutMs?: number): Promise<boolean> {
		const start = Date.now();
		while (isSaving) {
			if (timeoutMs !== undefined && Date.now() - start > timeoutMs) return false;
			await new Promise((r) => setTimeout(r, 100));
		}
		return true;
	}

	// --- Test Parameters panel: drive the preview with bound-param values ---

	interface BoundParamInfo {
		/** Name as it would appear in the URL query string. */
		name: string;
		/** Default value stored on the binding — applied when the URL omits the param. */
		default: string;
		/** Which template property first requested this param (e.g. "Text Content"),
		 * to help the user tell which binding a param drives. */
		sampleLabel: string;
	}

	type FabricLikeObject = {
		paramBindings?: Record<string, { param?: string; default?: string }>;
		conditionalStyles?: Array<{ when?: { param?: string } }>;
		type?: string;
	};

	function propLabel(property: string): string {
		switch (property) {
			case 'text':
				return 'Text Content';
			case 'src':
				return 'Image Source';
			case 'fill':
				return 'Fill Color';
			case 'visible':
				return 'Visibility';
			default:
				return property;
		}
	}

	/** Collect a deduped list of {name, default} across every paramBinding in the
	 * current canvas. Two bindings with the same name win with the first-seen
	 * default — matches how the runtime merges. Uses Object.create(null) plus
	 * Object.hasOwn() so identifiers inherited from Object.prototype (e.g.
	 * "constructor", "toString", "hasOwnProperty") aren't misread as already
	 * present and silently dropped. */
	function collectBoundParams(): BoundParamInfo[] {
		if (!editorState.fabricCanvas) return [];
		const json = editorState.fabricCanvas.toObject([...EDITOR_TO_OBJECT_PROPS]) as {
			objects?: FabricLikeObject[];
		};
		const seen: Record<string, BoundParamInfo> = Object.create(null);
		for (const obj of json.objects ?? []) {
			const bindings = obj.paramBindings;
			if (bindings) {
				for (const [property, binding] of Object.entries(bindings)) {
					// Use the raw stored name — the renderer does params[binding.param]
					// verbatim, so trimming here would show the user a preview URL
					// that doesn't match runtime lookup for names with whitespace.
					// We still skip empty strings since the runtime ignores those.
					const name = binding?.param;
					if (!name) continue;
					if (Object.hasOwn(seen, name)) continue;
					seen[name] = {
						name,
						default: binding?.default ?? '',
						sampleLabel: propLabel(property)
					};
				}
			}
			// Conditional rules can introduce params that aren't bound to any
			// property — without surfacing them here the preview's Test
			// Parameters panel can't drive a rule from the UI. First-seen
			// wins; bindings on the same name take precedence above.
			for (const rule of obj.conditionalStyles ?? []) {
				const name = rule.when?.param;
				if (!name) continue;
				if (Object.hasOwn(seen, name)) continue;
				seen[name] = {
					name,
					default: '',
					sampleLabel: 'Conditional rule'
				};
			}
		}
		return Object.values(seen).sort((a, b) => a.name.localeCompare(b.name));
	}

	let boundParams = $state<BoundParamInfo[]>([]);
	/** User-typed test values, keyed by param name. Starts empty (so the default
	 * is applied) and the user types to override. Separate from boundParams so
	 * edits survive re-discovery of bindings. */
	// Null-prototype object so parameter names that collide with Object.prototype
	// members ("constructor", "toString", …) don't shadow inherited properties.
	let testParams = $state<Record<string, string>>(Object.create(null));
	/** The query-string portion driving the preview image, updated only after a
	 * 300ms debounce so the user can type without thrashing the server. */
	let previewQuery = $state('');
	let previewDebounce: ReturnType<typeof setTimeout> | undefined;
	let previewNonce = $state(0);

	function buildPreviewQuery(values: Record<string, string>): string {
		// Build the query string manually (encodeURIComponent) rather than via
		// URLSearchParams to keep eslint-plugin-svelte's reactivity rule happy —
		// this is a pure helper, not a reactive source. Object.entries is safe
		// against prototype pollution (it only yields own enumerable keys).
		const parts: string[] = [];
		for (const [k, v] of Object.entries(values)) {
			if (v === '') continue; // empty means "fall through to binding default"
			parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
		}
		return parts.length ? `&${parts.join('&')}` : '';
	}

	function schedulePreviewRefresh() {
		clearTimeout(previewDebounce);
		previewDebounce = setTimeout(() => {
			previewQuery = buildPreviewQuery(testParams);
			previewNonce++;
		}, 300);
	}

	function setTestParam(name: string, value: string) {
		// Rebuild with a null-prototype object to preserve prototype-pollution
		// safety for identifiers like "constructor" or "toString".
		const next: Record<string, string> = Object.create(null);
		for (const [k, v] of Object.entries(testParams)) next[k] = v;
		next[name] = value;
		testParams = next;
		schedulePreviewRefresh();
	}

	let previewUrlFull = $derived(
		showPreview ? `/api/canvas/${data.canvas.id}/preview?_t=${previewNonce}${previewQuery}` : ''
	);

	/**
	 * Public share URL for the current canvas with the editor's test
	 * parameter values applied (TASK-107). This is what a viewer would
	 * load — `/c/<slug>?<params>` — NOT the editor's internal preview
	 * proxy. Provided as both a relative path (used in the inline
	 * preview-url code block to keep the display compact) and an
	 * absolute URL (used by the Copy / Open buttons so the copied
	 * value is immediately useful in any context).
	 *
	 * `previewQuery` is stored with a leading `&` because it splices
	 * into the preview proxy URL after `?_t=…`. For the standalone
	 * share URL we strip that leader and re-prefix `?` only when the
	 * query is non-empty so a no-params canvas stays clean.
	 */
	let sharePathWithParams = $derived(
		`/c/${canvasSlug}${previewQuery ? `?${previewQuery.slice(1)}` : ''}`
	);
	let shareUrlWithParams = $derived(
		typeof window !== 'undefined' ? `${window.location.origin}${sharePathWithParams}` : ''
	);

	/**
	 * Copy the current share URL to the clipboard. Toast confirms the
	 * action — without it the user has no signal whether the click
	 * registered, and the URL itself is not visually distinguishable
	 * from before vs. after the copy. The shared helper handles
	 * fallback to the textarea-select approach on the (rare) clients
	 * without async clipboard support so the button is never a no-op.
	 */
	async function copyShareUrl(): Promise<void> {
		const url = shareUrlWithParams;
		if (!url) return;
		await copyToClipboard(url, { success: 'Share URL copied' });
	}

	/**
	 * Open the current share URL in a new tab. `noopener,noreferrer`
	 * keeps the destination from accessing this window's `opener` and
	 * strips the Referer — both standard hygiene for user-supplied
	 * URLs (slug + query are user-controlled).
	 */
	function openShareUrl(): void {
		const url = shareUrlWithParams;
		if (!url) return;
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	async function togglePreview() {
		if (showPreview) {
			showPreview = false;
			previewUrl = '';
			previewQuery = '';
			clearTimeout(previewDebounce);
			return;
		}
		// Wait for any in-flight save, then save again to ensure latest state
		await waitForSave();
		const saved = await save();
		if (!saved) return; // Don't preview if save failed

		// Discover bound params from the freshly-saved template and seed test
		// inputs with empty strings (so defaults take effect). Preserve any
		// existing user-typed values for params that still exist. Uses a
		// null-prototype object so parameter names like "constructor" or
		// "toString" are handled correctly (prototype-pollution safe).
		const discovered = collectBoundParams();
		boundParams = discovered;
		const nextTest: Record<string, string> = Object.create(null);
		for (const p of discovered) {
			nextTest[p.name] = Object.hasOwn(testParams, p.name) ? testParams[p.name] : '';
		}
		testParams = nextTest;

		previewQuery = buildPreviewQuery(testParams);
		previewNonce = Date.now();
		showPreview = true;
	}

	$effect(() => {
		void previewUrlFull;
		previewUrl = previewUrlFull;
	});
</script>

<svelte:head>
	<title>Edit: {data.canvas.name} | Canvas</title>
</svelte:head>

<MobileBanner />

<div class="editor-layout">
	<header class="toolbar" data-testid="editor-toolbar">
		<a href="/dashboard" class="back-link" aria-label="Back to dashboard">
			<ArrowLeft size={14} aria-hidden="true" />
			<span>Dashboard</span>
		</a>
		<span class="canvas-name">{data.canvas.name}</span>

		<div class="toolbar-actions">
			<button
				class="tool-btn icon-only"
				data-testid="toolbar-undo"
				onclick={() => editorRef?.undoAction()}
				disabled={!historyState.canUndo}
				aria-label={historyState.canUndo ? 'Undo (Ctrl+Z)' : 'Nothing to undo'}
				title={historyState.canUndo ? 'Undo (Ctrl+Z)' : 'Nothing to undo yet'}
			>
				<Undo2 size={14} />
			</button>
			<button
				class="tool-btn icon-only"
				data-testid="toolbar-redo"
				onclick={() => editorRef?.redoAction()}
				disabled={!historyState.canRedo}
				aria-label={historyState.canRedo ? 'Redo (Ctrl+Shift+Z)' : 'Nothing to redo'}
				title={historyState.canRedo ? 'Redo (Ctrl+Shift+Z)' : 'Nothing to redo yet'}
			>
				<Redo2 size={14} />
			</button>
			<span class="toolbar-sep"></span>
			<button class="tool-btn" data-testid="toolbar-add-text" onclick={() => editorRef?.addText()}>
				<TypeIcon size={14} />
				<span>Text</span>
			</button>
			<button class="tool-btn" onclick={() => editorRef?.addRect()}>
				<Square size={14} />
				<span>Rectangle</span>
			</button>
			<button
				class="tool-btn"
				data-testid="toolbar-add-badge"
				onclick={() => editorRef?.addBadge()}
				title="Add badge / pill (auto-sizes to label)"
			>
				<TagIcon size={14} />
				<span>Badge</span>
			</button>
			<button
				class="tool-btn"
				data-testid="toolbar-canvas-size"
				onclick={() => (showSettingsModal = true)}
				title="Canvas size and background"
			>
				{canvasWidth}×{canvasHeight}
			</button>
			<button
				class="tool-btn"
				data-testid="toolbar-add-image"
				onclick={() => (showAddImageModal = true)}
				disabled={isUploading}
			>
				<ImageIcon size={14} />
				<span>{isUploading ? 'Uploading…' : 'Image'}</span>
			</button>
			<button class="tool-btn delete-btn" onclick={() => editorRef?.deleteSelected()}>
				<Trash2 size={14} />
				<span>Delete</span>
			</button>
			<button
				class="tool-btn"
				data-testid="toolbar-duplicate"
				onclick={duplicateInEditor}
				disabled={duplicating || isUploading || isInsertingImage}
				title="Duplicate this canvas as a new draft"
			>
				<Copy size={14} />
				<span>{duplicating ? 'Duplicating…' : 'Duplicate'}</span>
			</button>
		</div>

		{#if editorState.activeObjects.length >= 2}
			<span class="toolbar-sep"></span>
			<div
				class="align-group"
				role="group"
				aria-label="Align selected objects"
				data-testid="align-toolbar"
			>
				<button
					class="tool-btn icon-only"
					data-testid="align-left"
					title="Align left"
					aria-label="Align left"
					onclick={() => editorRef?.alignSelected('left')}>⫷</button
				>
				<button
					class="tool-btn icon-only"
					data-testid="align-center-h"
					title="Align horizontal center"
					aria-label="Align horizontal center"
					onclick={() => editorRef?.alignSelected('center-h')}>⊻</button
				>
				<button
					class="tool-btn icon-only"
					data-testid="align-right"
					title="Align right"
					aria-label="Align right"
					onclick={() => editorRef?.alignSelected('right')}>⫸</button
				>
				<button
					class="tool-btn icon-only"
					data-testid="align-top"
					title="Align top"
					aria-label="Align top"
					onclick={() => editorRef?.alignSelected('top')}>⫶</button
				>
				<button
					class="tool-btn icon-only"
					data-testid="align-center-v"
					title="Align vertical center"
					aria-label="Align vertical center"
					onclick={() => editorRef?.alignSelected('center-v')}>⊞</button
				>
				<button
					class="tool-btn icon-only"
					data-testid="align-bottom"
					title="Align bottom"
					aria-label="Align bottom"
					onclick={() => editorRef?.alignSelected('bottom')}>⫶</button
				>
				{#if editorState.activeObjects.length >= 3}
					<button
						class="tool-btn icon-only"
						data-testid="distribute-h"
						title="Distribute horizontally"
						aria-label="Distribute horizontally"
						onclick={() => editorRef?.distributeSelected('h')}>↔</button
					>
					<button
						class="tool-btn icon-only"
						data-testid="distribute-v"
						title="Distribute vertically"
						aria-label="Distribute vertically"
						onclick={() => editorRef?.distributeSelected('v')}>↕</button
					>
				{/if}
			</div>
		{/if}

		<span class="toolbar-sep"></span>
		<button
			class="tool-btn"
			data-testid="toolbar-params"
			onclick={() => (showParamsPanel = true)}
			title="View / edit URL parameters for this canvas"
		>
			<Sliders size={14} />
			<span>Params</span>
		</button>
		<button class="tool-btn" class:active={showPreview} onclick={togglePreview}>
			{#if showPreview}
				<EyeOff size={14} />
				<span>Close Preview</span>
			{:else}
				<Eye size={14} />
				<span>Preview</span>
			{/if}
		</button>

		<!--
			Zoom controls (TASK-150). Editor-only chrome — Fabric's intrinsic
			coordinate system is untouched, so undo/redo/save/export all
			ignore this. The "value" button toggles between 100% and Fit so
			a user who's zoomed mid-edit has one click to either escape.
		-->
		<div class="zoom-controls" role="group" aria-label="Zoom">
			<button
				type="button"
				class="tool-btn icon-only"
				data-testid="toolbar-zoom-out"
				onclick={() => editorRef?.zoomBy(0.8)}
				aria-label="Zoom out"
				title="Zoom out (Cmd/Ctrl + scroll)"
			>
				−
			</button>
			<button
				type="button"
				class="tool-btn zoom-value"
				data-testid="toolbar-zoom-value"
				onclick={() => {
					// Click cycles Fit → 100% → Fit. If we're already at 100%
					// in manual mode, the obvious next step is back to Fit;
					// otherwise jump to 100%. Most users want one of the two
					// canonical zoom levels.
					if (editorState.zoomMode === 'manual' && Math.abs(editorState.zoom - 1) < 0.005) {
						editorRef?.zoomToFit();
					} else {
						editorRef?.zoomToActual(1);
					}
				}}
				aria-label="Toggle 100% / Fit"
				title="Click to toggle 100% / Fit"
			>
				{editorState.zoomMode === 'fit' && Math.abs(editorState.zoom - 1) >= 0.005
					? 'Fit'
					: `${Math.round(editorState.zoom * 100)}%`}
			</button>
			<button
				type="button"
				class="tool-btn icon-only"
				data-testid="toolbar-zoom-in"
				onclick={() => editorRef?.zoomBy(1.25)}
				aria-label="Zoom in"
				title="Zoom in (Cmd/Ctrl + scroll)"
			>
				+
			</button>
		</div>

		<div class="spacer"></div>

		<button
			class="tool-btn icon-only"
			data-testid="toolbar-shortcuts"
			onclick={() => (showCheatsheet = true)}
			aria-label="Keyboard shortcuts (?)"
			title="Keyboard shortcuts (?)"
		>
			<Keyboard size={14} />
		</button>

		<!--
			BT-160: the Save button doubles as the save-status indicator.
			It absorbs the role of the old "All changes saved" /
			"Unsaved changes" / "Saving…" pill (which dynamically resized
			the toolbar and reflowed neighbours) and of the
			Live-render-sync pill from TASK-108 (whose state was a pure
			function of save status anyway, since every save updates the
			live render). One control, fixed footprint, manual saves only.
		-->
		<button
			type="button"
			class="save-btn save-btn-{saveButtonState}"
			data-testid="toolbar-save"
			data-state={saveButtonState}
			onclick={save}
			disabled={saveButtonState === 'saving' || saveButtonState === 'saved'}
			title={saveButtonLabel(saveButtonState)}
		>
			{saveButtonLabel(saveButtonState)}
		</button>

		<button
			type="button"
			class="publish-btn"
			data-testid="toolbar-publish"
			class:published={isPublished}
			disabled={openingPublish}
			onclick={openPublishModal}
		>
			{openingPublish ? 'Loading…' : isPublished ? 'Published' : 'Publish'}
		</button>
	</header>

	<div class="main-area" data-testid="editor-main-area">
		<LayerPanel
			onToggleSelect={(obj, additive) => editorRef?.toggleLayerSelection(obj, additive)}
		/>

		<div
			class="canvas-container"
			class:drag-over={isDraggingFile}
			ondragenter={onDragEnter}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
			onwheel={(e) => {
				// Cmd/Ctrl + wheel = zoom (anchored at cursor). Trackpad
				// pinch on macOS/Windows arrives as `wheel` with ctrlKey
				// synthesized by the browser, so this handler covers both
				// modifier-wheel and pinch gestures with one branch.
				// Plain wheel falls through to native scroll on this
				// `overflow:auto` container — that's the canvas pan.
				if (e.ctrlKey || e.metaKey) {
					void editorRef?.applyWheelZoom(e);
				}
			}}
			role="region"
			aria-label="Canvas — drop an image here to add it"
		>
			<!-- Why CanvasEditor is OUTSIDE the boundary: a render error
				inside CanvasEditor tears down the Fabric canvas, which
				resets editorState.isDirty=false on cleanup. With the
				boundary wrapping CanvasEditor, the user could lose
				unsaved edits without ever seeing the navigation-guard
				warning. We let render errors in CanvasEditor bubble to
				the route-level +error.svelte (shipped in TASK-54) — a
				full-page error is the honest signal that the canvas
				state is unrecoverable. PropertyPanel below is a separate
				story: its bindings/conditional-rules editor can throw
				on malformed data, and recovering it without losing the
				Fabric state is the actual win. -->
			<CanvasEditor
				bind:this={editorRef}
				width={canvasWidth}
				height={canvasHeight}
				{backgroundColor}
			/>
			{#if isDraggingFile}
				<div class="drop-overlay" aria-hidden="true">
					<div class="drop-hint">Drop to add image</div>
				</div>
			{/if}
		</div>

		<svelte:boundary
			onerror={(err: unknown) => {
				console.error('[property-panel boundary] unhandled error during render:', err);
			}}
		>
			<PropertyPanel />

			{#snippet failed(err: unknown, reset: () => void)}
				<!-- Property-panel-only failure. The Fabric canvas next to
					us is still healthy, so the user's unsaved work is
					still tracked by editorState.isDirty and the
					beforeNavigate guard still fires. -->
				<aside class="property-panel-error" role="alert">
					<AlertTriangleIcon size={28} aria-hidden="true" />
					<h2>Property panel error</h2>
					<p>The properties for the selected layer couldn't render.</p>
					{#if err instanceof Error && err.message}
						<p class="editor-error-detail"><code>{err.message}</code></p>
					{/if}
					<button type="button" class="btn btn-primary" onclick={reset}>Retry</button>
				</aside>
			{/snippet}
		</svelte:boundary>
	</div>

	<ConfirmDialog
		open={pendingNavigationHref !== null}
		title="Leave without saving?"
		message="You have unsaved changes. Leaving now will discard them."
		confirmLabel="Leave anyway"
		cancelLabel="Stay"
		variant="danger"
		onConfirm={confirmLeave}
		onCancel={cancelLeave}
	/>

	<CanvasSettingsModal
		open={showSettingsModal}
		canvasId={data.canvas.id}
		currentWidth={canvasWidth}
		currentHeight={canvasHeight}
		currentBackgroundType={canvasBgType}
		currentBackgroundValue={canvasBgValue}
		hasContent={(editorState.fabricCanvas?.getObjects().length ?? 0) > 0}
		onClose={() => (showSettingsModal = false)}
		onApplied={(patch: CanvasSettingsPatch) => {
			canvasWidth = patch.width;
			canvasHeight = patch.height;
			canvasBgType = patch.backgroundType;
			canvasBgValue = patch.backgroundValue;
			// Resize Fabric in place. CanvasEditor keys off width/height props,
			// but we need to poke Fabric directly so active objects and viewport
			// update immediately.
			if (editorState.fabricCanvas) {
				editorState.fabricCanvas.setDimensions({ width: patch.width, height: patch.height });
				if (patch.backgroundType === 'color') {
					editorState.fabricCanvas.backgroundColor = patch.backgroundValue;
				}
				editorState.fabricCanvas.renderAll();
			}
		}}
	/>

	<AddImageModal
		open={showAddImageModal}
		acceptedTypes={ACCEPTED_IMAGE_TYPES}
		maxBytes={MAX_IMAGE_BYTES}
		onClose={() => (showAddImageModal = false)}
		onSelect={onAddImageModalSelect}
		onUploadingChange={(v) => (isUploading = v)}
	/>

	<PublishModal
		open={showPublishModal}
		canvasId={data.canvas.id}
		slug={canvasSlug}
		published={isPublished}
		bindings={publishBindings}
		bindingsStale={publishBindingsStale}
		onClose={() => (showPublishModal = false)}
		onPublishedChange={(next) => (isPublished = next)}
		onSlugChange={(next) => (canvasSlug = next)}
		onBeforePublish={async () => {
			// Flush any in-flight save and persist any pending edits so the
			// published URL renders the latest state, not whatever was last
			// committed before the user hit Publish. With manual-only saves
			// (BT-160) this is the canonical path for pre-publish flushing.
			await waitForSave();
			if (!editorState.isDirty) return true;
			return await save();
		}}
	/>

	<ParamsPanel
		open={showParamsPanel}
		canvasId={data.canvas.id}
		published={isPublished}
		onClose={() => (showParamsPanel = false)}
	/>

	<ShortcutsCheatsheetModal open={showCheatsheet} onClose={() => (showCheatsheet = false)} />

	{#if showPreview && previewUrl}
		<div class="preview-panel">
			<div class="preview-header">
				<strong>Rendered Preview</strong>
				<span class="preview-info">
					{data.canvas.width} × {data.canvas.height} · {canvasSlug}
				</span>
			</div>
			<div class="preview-body">
				<div class="preview-image">
					<img src={previewUrl} alt="Canvas preview" />
				</div>
				<div class="preview-params">
					<div class="preview-params-header">Test Parameters</div>
					{#if boundParams.length === 0}
						<p class="preview-params-empty">
							No dynamic parameters yet. Select a layer in the property panel and click the
							<strong>⚡</strong> next to any property to bind it to a URL parameter.
						</p>
					{:else}
						<p class="preview-params-hint">
							Type values to preview how the published URL will render. Leave blank to use the
							binding default.
						</p>
						{#each boundParams as p (p.name)}
							<div class="preview-param-row">
								<label class="preview-param-label" for="test-param-{p.name}">
									{p.name}
									<span class="preview-param-source" title="Bound from {p.sampleLabel}">
										{p.sampleLabel}
									</span>
								</label>
								<input
									id="test-param-{p.name}"
									type="text"
									class="preview-param-input"
									value={testParams[p.name] ?? ''}
									oninput={(e) => setTestParam(p.name, e.currentTarget.value)}
									placeholder={p.default || 'default is empty'}
								/>
							</div>
						{/each}
					{/if}
				</div>
			</div>
			<div class="preview-url">
				<code>{sharePathWithParams}</code>
				<!--
					Copy / open buttons (TASK-107). previewQuery is already
					reactive against testParams, so the buttons always copy
					the URL the user is CURRENTLY previewing. Disabled until
					the canvas is published — visiting /c/<slug> on an
					unpublished canvas 404s, so opening / copying that link
					would lead to a dead end.
				-->
				<div class="preview-url-actions" data-testid="preview-url-actions">
					<button
						type="button"
						class="preview-url-btn"
						onclick={copyShareUrl}
						disabled={!isPublished}
						aria-label="Copy share URL with current preview parameters"
						title={isPublished
							? 'Copies the share URL with your current test param values filled in.'
							: 'Publish the canvas first.'}
						data-testid="preview-url-copy"
					>
						<Copy size={12} />
						<span>Copy URL</span>
					</button>
					<button
						type="button"
						class="preview-url-btn"
						onclick={openShareUrl}
						disabled={!isPublished}
						aria-label="Open share URL in a new tab"
						title={isPublished
							? 'Opens the share URL with your current test param values in a new tab.'
							: 'Publish the canvas first.'}
						data-testid="preview-url-open"
					>
						<ExternalLink size={12} />
						<span>Open</span>
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.editor-layout {
		display: flex;
		flex-direction: column;
		height: 100vh;
		/* BT-158: cap the layout to viewport width. Without these, an
		   overflowing toolbar row pushes the .editor-layout (and the
		   whole page) wider than the viewport, producing horizontal
		   page scroll. `min-width: 0` is the canonical flex escape
		   hatch — without it the default `min-width: auto` on flex
		   items lets their intrinsic content size win over the
		   container constraint. */
		width: 100%;
		min-width: 0;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
	}

	/*
	 * BT-158: toolbar responsive overhaul.
	 *
	 * Before this fix the toolbar was a single non-wrapping flex row with
	 * ~15 controls (back-link, canvas-name, 10 tool buttons, optional 6–8
	 * alignment buttons, params/preview, zoom widget, save indicator,
	 * Save, Publish). Natural width hits ~1500px with labels visible —
	 * comfortably wider than typical 1280–1440px desktops, so the row
	 * overflowed and dragged the whole page horizontally.
	 *
	 * Strategy: keep one row when it fits, wrap to a second row when it
	 * doesn't, and collapse the icon+label buttons to icon-only at
	 * ≤1440px so the single-row case covers the common desktop range.
	 * Label `<span>`s are visually hidden (not removed) so screen readers
	 * and Playwright's accessible-name selectors still see them.
	 *
	 * The MobileBanner overlay still gates everything below 1024px, so
	 * this fix targets the 1024–1440px window where the bug actually
	 * shows up.
	 */
	.toolbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
		row-gap: 4px;
		min-height: 48px;
		padding: 4px 16px;
		border-bottom: 1px solid #e2e8f0;
		background: #fff;
		flex-shrink: 0;
	}

	.back-link {
		color: #2563eb;
		text-decoration: none;
		font-size: 14px;
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.back-link:hover {
		text-decoration: underline;
	}

	.canvas-name {
		font-weight: 600;
		font-size: 14px;
		color: #1e293b;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		/* BT-158: scale down on narrow viewports so the canvas name
		   doesn't crowd the toolbar at 1024–1280px widths. 200px is
		   the desktop ceiling (long names get truncated with
		   ellipsis); `30vw` shrinks proportionally on narrower
		   viewports while still keeping enough characters to identify
		   the canvas. */
		max-width: min(200px, 30vw);
		/* Prevent the flex layout from shrinking the canvas name to zero
		   width when the toolbar gets crowded (e.g. with the TASK-150
		   zoom widget added). `overflow: hidden` here would otherwise
		   let flex collapse the element entirely, hiding the canvas
		   name and breaking E2E selectors that target it (TASK-156). */
		flex-shrink: 0;
	}

	.toolbar-actions {
		display: flex;
		gap: 6px;
	}

	.tool-btn {
		padding: 4px 10px;
		font-size: 13px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: #1e293b;
	}

	.tool-btn.icon-only {
		padding: 4px 6px;
	}

	.tool-btn :global(svg) {
		display: block;
		flex-shrink: 0;
	}

	.tool-btn:hover {
		background: #f3f4f6;
	}

	.tool-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
		background: #f3f4f6;
		color: #9ca3af;
		border-color: #e5e7eb;
	}

	.tool-btn:disabled:hover {
		background: #f3f4f6;
	}

	.tool-btn:disabled :global(svg) {
		color: #9ca3af;
	}

	.toolbar-sep {
		width: 1px;
		height: 20px;
		background: #d1d5db;
		align-self: center;
	}

	/* TASK-150: zoom control cluster. Three buttons share a single
	   border so the group reads as a single segmented control instead
	   of three loose buttons. The "value" button in the middle is wider
	   to fit "100%" / "Fit" / "400%" without reflowing on every step.
	   `flex-shrink: 0` keeps the cluster at its natural size — without
	   it, a crowded toolbar shrinks the flex item below its content and
	   `overflow: hidden` clips the inner buttons, leading to clicks
	   landing on the parent div instead of the intended button. */
	.zoom-controls {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		overflow: hidden;
		background: #fff;
	}

	.zoom-controls .tool-btn {
		border: none;
		border-radius: 0;
		background: transparent;
	}

	.zoom-controls .tool-btn + .tool-btn {
		border-left: 1px solid #e5e7eb;
	}

	.zoom-controls .tool-btn.icon-only {
		padding: 4px 8px;
		font-size: 14px;
		font-weight: 600;
		line-height: 1;
		color: #475569;
		font-variant-numeric: tabular-nums;
	}

	.zoom-controls .zoom-value {
		min-width: 3.5rem;
		justify-content: center;
		font-size: 12px;
		font-weight: 500;
		color: #1e293b;
		font-variant-numeric: tabular-nums;
	}

	.delete-btn {
		color: #dc2626;
		border-color: #fca5a5;
	}

	.delete-btn:hover {
		background: #fef2f2;
	}

	.spacer {
		flex: 1;
	}

	/* BT-160: Save button doubles as the save-status indicator. A FIXED
	   min-width keeps the toolbar from reflowing as the label changes
	   between "Save" / "Saving…" / "Saved" / "Retry save" — the previous
	   pill-driven layout shift was the original reason this bug was filed.
	   Per-state styles below override only color + cursor; geometry stays
	   constant across all states. */
	.save-btn {
		min-width: 96px;
		padding: 5px 16px;
		font-size: 13px;
		font-weight: 500;
		border: 1px solid transparent;
		border-radius: 4px;
		background: #2563eb;
		color: #fff;
		cursor: pointer;
		white-space: nowrap;
		text-align: center;
	}

	.save-btn:hover:not(:disabled) {
		background: #1d4ed8;
	}

	.save-btn:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}

	/* Dirty (default appearance) is the primary blue above. */

	/* Saved — clean, disabled. Muted appearance so the eye isn't drawn
	   to a button that has nothing to do. */
	.save-btn-saved {
		background: #f1f5f9;
		color: #475569;
		border-color: #e2e8f0;
		cursor: default;
	}

	/* Saving — disabled, subtly pulsing to signal in-flight work. */
	.save-btn-saving {
		background: #93c5fd;
		color: #fff;
		cursor: wait;
		animation: save-btn-pulse 1s ease-in-out infinite;
	}

	/* Failed — red, enabled so the user can retry by clicking. */
	.save-btn-failed {
		background: #dc2626;
		color: #fff;
		border-color: #b91c1c;
	}

	.save-btn-failed:hover:not(:disabled) {
		background: #b91c1c;
	}

	@keyframes save-btn-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.7;
		}
	}

	.publish-btn {
		font-size: 13px;
		font-weight: 500;
		padding: 5px 12px;
		border-radius: 4px;
		background: #fff;
		color: #374151;
		border: 1px solid #d1d5db;
		cursor: pointer;
		white-space: nowrap;
	}

	.publish-btn:hover {
		background: #f3f4f6;
	}

	.publish-btn:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}

	.publish-btn.published {
		background: #dcfce7;
		color: #15803d;
		border-color: #86efac;
	}

	.publish-btn.published:hover {
		background: #bbf7d0;
	}

	/*
	 * BT-158: at ≤1440px the toolbar can't fit every icon+label button on
	 * a single row alongside the back-link, canvas-name, zoom widget, and
	 * Save/Publish CTAs. Collapse the icon+label buttons to their icons
	 * by visually hiding the label `<span>`. The text remains in the
	 * DOM, so:
	 *   - tooltips (title=) and aria-labels keep working on hover/AT
	 *   - Playwright's getByRole({ name: 'Rectangle' }) still resolves
	 *     (accessible-name computation reads clipped sr-only text)
	 *   - the `.toolbar .icon-only` selector still picks up only the
	 *     genuinely icon-only buttons, so regressions.test.ts:131
	 *     unchanged.
	 *
	 * Selector intentionally excludes `.icon-only` (already iconified)
	 * and `.zoom-value` (label IS the visible value — "100%" / "Fit").
	 * `> span` reaches only direct-child `<span>`s, leaving the
	 * `.canvas-name` untouched (it isn't a descendant of `.tool-btn`).
	 * The Save button's BT-160 status states live on the button itself
	 * (no inner span), so this rule never reaches them.
	 */
	@media (max-width: 1440px) {
		.toolbar {
			gap: 8px;
		}
		.toolbar-actions {
			gap: 4px;
		}
		.tool-btn:not(.icon-only):not(.zoom-value) > span {
			/* Standard sr-only / visually-hidden pattern — invisible but
			   still part of the accessible name computation. */
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
			border: 0;
		}
		.tool-btn:not(.icon-only):not(.zoom-value) {
			padding: 4px 8px;
		}
	}

	.property-panel-error {
		width: 280px;
		min-width: 280px;
		padding: 1.25rem 1rem;
		border-left: 1px solid #ddd;
		background: #fff;
		font-family: system-ui, sans-serif;
		text-align: center;
	}

	.property-panel-error :global(svg) {
		color: #dc2626;
		display: block;
		margin: 0 auto 0.5rem;
	}

	.property-panel-error h2 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		font-weight: 700;
		color: #1e293b;
	}

	.property-panel-error p {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
		color: #475569;
		line-height: 1.5;
	}

	.editor-error-detail code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		background: #f1f5f9;
		padding: 0.15rem 0.35rem;
		border-radius: 3px;
		display: inline-block;
		max-width: 100%;
		overflow-x: auto;
	}

	.property-panel-error .btn {
		padding: 0.4rem 0.85rem;
		border-radius: 5px;
		font-size: 0.8125rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
	}

	.property-panel-error .btn-primary {
		background: #2563eb;
		color: #fff;
	}

	.main-area {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.canvas-container {
		flex: 1;
		display: flex;
		/* TASK-150: `safe center` on both axes centers the canvas stage
		   when it fits, but falls back to start-aligned when the stage
		   overflows — so the top-left of an oversized canvas stays
		   reachable via scroll. Bare `center` (the previous value) put
		   the stage's overflow off the start edge of the scrollable
		   area, which is exactly the "can't scroll left/up" bug users
		   reported. Single-line flex needs `align-items` for cross-axis
		   centering — `place-content` would map to `align-content`,
		   which has no effect on a single-line flex (Codex round 1 P3).
		   The `safe` keyword is supported in every browser we target
		   (Chrome 93+, Firefox 63+, Safari 11+). */
		align-items: safe center;
		justify-content: safe center;
		background: #f1f5f9;
		overflow: auto;
		padding: 24px;
		position: relative;
	}

	.canvas-container.drag-over {
		background: #e0e7ff;
	}

	.drop-overlay {
		position: absolute;
		inset: 12px;
		border: 3px dashed #2563eb;
		border-radius: 8px;
		background: rgba(37, 99, 235, 0.08);
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}

	.drop-hint {
		background: #fff;
		padding: 10px 18px;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 600;
		color: #1e40af;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
	}

	.tool-btn.active {
		background: #2563eb;
		color: #fff;
		border-color: #2563eb;
	}

	.preview-panel {
		border-top: 2px solid #e2e8f0;
		background: #f8fafc;
		padding: 16px 24px;
	}

	.preview-header {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
		font-size: 13px;
	}

	.preview-info {
		color: #94a3b8;
	}

	.preview-body {
		display: flex;
		gap: 20px;
		align-items: flex-start;
		justify-content: center;
	}

	.preview-image {
		flex: 0 1 auto;
		min-width: 0;
	}

	.preview-image img {
		max-width: 100%;
		max-height: 300px;
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.preview-params {
		flex: 0 0 260px;
		text-align: left;
		background: #fff;
		border: 1px solid #e2e8f0;
		border-radius: 6px;
		padding: 10px 12px;
		max-height: 300px;
		overflow-y: auto;
	}

	.preview-params-header {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #64748b;
		margin-bottom: 6px;
	}

	.preview-params-hint {
		font-size: 11px;
		color: #64748b;
		line-height: 1.4;
		margin: 0 0 8px;
	}

	.preview-params-empty {
		font-size: 11.5px;
		color: #64748b;
		line-height: 1.5;
		margin: 0;
	}

	.preview-param-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 8px;
	}

	.preview-param-label {
		font-size: 11px;
		font-weight: 600;
		color: #334155;
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}

	.preview-param-source {
		font-size: 10px;
		font-weight: 400;
		color: #94a3b8;
	}

	.preview-param-input {
		width: 100%;
		padding: 4px 6px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		font-size: 12px;
		font-family: inherit;
		background: #fff;
	}

	.preview-param-input:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18);
	}

	.preview-url {
		margin-top: 12px;
		font-size: 12px;
		color: #64748b;
		text-align: center;
		word-break: break-all;
	}

	.preview-url code {
		background: #e2e8f0;
		padding: 2px 8px;
		border-radius: 3px;
	}

	/* TASK-107: Copy / Open buttons in the preview-url block. Sit on
	   their own line below the URL so the URL itself stays the visual
	   anchor of the section — pushing them inline with `code` would
	   either crowd the URL or wrap awkwardly on narrow viewports. */
	.preview-url-actions {
		display: flex;
		justify-content: center;
		gap: 6px;
		margin-top: 6px;
	}

	.preview-url-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 9px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		background: #fff;
		color: #334155;
		font-family: inherit;
		font-size: 11.5px;
		font-weight: 500;
		cursor: pointer;
	}

	.preview-url-btn:hover {
		background: #f1f5f9;
		border-color: #94a3b8;
	}

	.preview-url-btn:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 1px;
	}

	.preview-url-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
		background: #f8fafc;
	}
</style>
