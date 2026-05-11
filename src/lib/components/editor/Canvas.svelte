<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Canvas, IText, FabricImage, Rect, ActiveSelection, type FabricObject } from 'fabric';
	import {
		editorState,
		setFabricCanvas,
		setSelectedObject,
		setActiveObjects,
		syncObjects,
		markDirty,
		setSnapshotCallback,
		setZoomState,
		ZOOM_MIN,
		ZOOM_MAX
	} from './state.svelte.ts';
	import { saveSnapshot, undo, redo, resetHistory, historyState } from './history.svelte.ts';
	import { setupSnapping } from './snapping.js';
	import { EDITOR_TO_OBJECT_PROPS } from './serialize.ts';
	// Importing Badge runs its `classRegistry.setClass(Badge)` side effect so
	// `loadFromJSON` / `enlivenObjects` can deserialize Badge layers (TASK-87).
	import { Badge } from './Badge.ts';

	let {
		width,
		height,
		backgroundColor
	}: {
		width: number;
		height: number;
		backgroundColor: string;
	} = $props();

	let canvasEl: HTMLCanvasElement;
	let wrapperEl: HTMLDivElement;
	/** Flips true once the Fabric canvas constructor returns and the
	 * wrapper has been wired into the editor state. The skeleton
	 * overlay below uses this — pre-mount the canvas region is blank
	 * white for ~1-2s while Fabric loads, which feels like a broken
	 * page. The skeleton at least signals "loading" during that gap. */
	let fabricMounted = $state(false);

	/** Visual zoom for the canvas — CSS transform on .canvas-wrapper,
	 *  NOT Fabric's setZoom. The Fabric canvas keeps its authored
	 *  dimensions (e.g. 1200×630) regardless, so exports / hit-testing
	 *  / save serialization stay oblivious. Derived from
	 *  `editorState.zoom` so the canvas-id change path in the editor
	 *  route (which doesn't remount this component on SPA navigation)
	 *  can reset zoom for the new canvas in one place. All writes from
	 *  inside this component go through `setZoomState()`. (TASK-150) */
	let zoom = $derived(editorState.zoom);

	/** Resolve the scroll container that holds this canvas. The editor
	 *  route wraps Canvas.svelte in `.canvas-container { overflow: auto }`
	 *  — that element is what we scroll for cursor-anchored zoom and
	 *  what we observe for auto-fit. `.closest()` avoids prop-drilling
	 *  the element through. Returns null until after mount. */
	function getScrollContainer(): HTMLElement | null {
		return wrapperEl?.closest('.canvas-container') ?? null;
	}

	/** "Fit" scale for the current container size — the largest scale
	 *  ≤ 1 at which both axes fit, with 5% breathing room. Caps at 1
	 *  so a small canvas never gets stretched up. Returns 1 if the
	 *  container hasn't been measured yet (initial render). */
	function computeFitScale(): number {
		const container = getScrollContainer();
		if (!container) return 1;
		// Subtract padding from the inner width/height the canvas can
		// actually occupy. getBoundingClientRect includes padding so
		// the math stays correct regardless of border-box vs content-box.
		const styles = getComputedStyle(container);
		const padX = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0');
		const padY = parseFloat(styles.paddingTop || '0') + parseFloat(styles.paddingBottom || '0');
		const availW = Math.max(0, container.clientWidth - padX);
		const availH = Math.max(0, container.clientHeight - padY);
		if (availW === 0 || availH === 0) return 1;
		const scale = Math.min(availW / width, availH / height) * 0.95;
		return Math.min(1, Math.max(ZOOM_MIN, scale));
	}

	/** Apply the auto-fit scale if zoomMode is 'fit'. No-op in 'manual'
	 *  mode — the user has chosen a scale and we don't override on resize. */
	function applyFitIfTracking() {
		if (editorState.zoomMode !== 'fit') return;
		setZoomState(computeFitScale(), 'fit');
	}

	/** Set zoom to exactly `value` (clamped) and switch to manual mode.
	 *  Used by the toolbar's 100% / +/− buttons and the keyboard
	 *  shortcuts. Does NOT adjust scroll position — appropriate for
	 *  "fit to known scale" actions where there's no cursor anchor. */
	export function zoomToActual(value = 1) {
		setZoomState(value, 'manual');
	}

	/** Switch back to auto-fit mode. Computes the fit scale immediately
	 *  so the canvas snaps into view without waiting for the next
	 *  ResizeObserver tick. */
	export function zoomToFit() {
		setZoomState(computeFitScale(), 'fit');
	}

	/** Multiply current zoom by `factor`, clamped. Toolbar +/− call this
	 *  with 1.25 / 0.8. Bumps to manual mode so a +/− press doesn't get
	 *  immediately overridden by the next ResizeObserver fire. */
	export function zoomBy(factor: number) {
		zoomToActual(zoom * factor);
	}

	/** Cmd/Ctrl + wheel: zoom anchored at the cursor. Computes the
	 *  canvas-coord point under the cursor before the scale change,
	 *  applies the new scale, then adjusts the scroll container so
	 *  the same canvas-coord point ends up under the cursor again.
	 *  Standard "zoom to pointer" pattern; tick() to let Svelte flush
	 *  the transform before reading the post-zoom layout. */
	export async function applyWheelZoom(e: WheelEvent) {
		// Translate wheel delta into a multiplicative scale step. The
		// 0.0015 constant tunes the rate; tested to feel like Figma at
		// medium-precision trackpads + ordinary mousewheels. Sign of
		// deltaY: positive = scroll down = zoom out (matches macOS /
		// Figma). preventDefault before any state changes so the
		// browser doesn't also start its own page zoom on Ctrl+wheel.
		e.preventDefault();
		const container = getScrollContainer();
		if (!container) return;
		const oldZoom = zoom;
		const factor = Math.exp(-e.deltaY * 0.0015);
		const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldZoom * factor));
		if (nextZoom === oldZoom) return;
		// Canvas-space point under the cursor BEFORE the zoom change.
		const wrapperRect = wrapperEl.getBoundingClientRect();
		const canvasX = (e.clientX - wrapperRect.left) / oldZoom;
		const canvasY = (e.clientY - wrapperRect.top) / oldZoom;
		setZoomState(nextZoom, 'manual');
		// Wait for Svelte to flush the transform-driven layout change
		// before computing the scroll correction — otherwise we'd read
		// stale rects and the anchor would drift.
		await tick();
		const newRect = wrapperEl.getBoundingClientRect();
		// Where the wrapper's top-left WOULD need to be for the canvas
		// point to land under the cursor:
		const targetLeft = e.clientX - canvasX * nextZoom;
		const targetTop = e.clientY - canvasY * nextZoom;
		container.scrollLeft += newRect.left - targetLeft;
		container.scrollTop += newRect.top - targetTop;
	}

	onMount(() => {
		const canvas = new Canvas(canvasEl, {
			width,
			height,
			backgroundColor,
			selection: true
		});

		setFabricCanvas(canvas);
		resetHistory();
		fabricMounted = true;

		// Auto-fit observer: when the scroll container resizes (window
		// resize, sidebar collapse, mobile keyboard appearance), re-run
		// the fit calc IF the user hasn't manually zoomed. Skipped in
		// 'manual' mode so a user-chosen scale isn't reset behind their
		// back. Initial fit on the next frame so getBoundingClientRect
		// sees the laid-out container, not the pre-mount one.
		const container = getScrollContainer();
		let resizeObserver: ResizeObserver | null = null;
		if (container && typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(() => applyFitIfTracking());
			resizeObserver.observe(container);
		}
		// One-shot initial fit. ResizeObserver fires on first observe,
		// but the container's layout may not be final yet (font load,
		// flex flushing) — a deferred frame catches the settled size.
		requestAnimationFrame(() => applyFitIfTracking());

		// Register snapshot callback so markDirty() from any component records history
		setSnapshotCallback(() => {
			if (!historyState.suppressSnapshots) saveSnapshot(canvas);
		});

		// Set up snapping guides
		const cleanupSnapping = setupSnapping(canvas);

		canvas.on('selection:created', (e) => {
			setSelectedObject(e.selected[0] ?? null);
			setActiveObjects(canvas.getActiveObjects());
		});

		canvas.on('selection:updated', (e) => {
			setSelectedObject(e.selected[0] ?? null);
			setActiveObjects(canvas.getActiveObjects());
		});

		canvas.on('selection:cleared', () => {
			setSelectedObject(null);
			setActiveObjects([]);
		});

		canvas.on('object:modified', () => {
			syncObjects();
			markDirty();
		});

		canvas.on('object:added', () => {
			syncObjects();
			markDirty();
		});

		canvas.on('object:removed', () => {
			syncObjects();
			markDirty();
		});

		return () => {
			cleanupSnapping();
			setSnapshotCallback(null);
			canvas.dispose();
			setFabricCanvas(null);
			resetHistory();
			fabricMounted = false;
			resizeObserver?.disconnect();
		};
	});

	// Width/height props can change mid-mount (settings modal → resize
	// canvas). Re-fit when they do so the new dimensions still fit the
	// visible container. Skipped in 'manual' mode for the same reason
	// the ResizeObserver is.
	$effect(() => {
		// Touch reactive deps so the effect re-runs on size changes.
		void width;
		void height;
		applyFitIfTracking();
	});

	export function addText() {
		if (!editorState.fabricCanvas) return;
		const text = new IText('Edit me', {
			fontFamily: 'Inter',
			fontSize: 32,
			fill: '#000000',
			left: width / 2 - 60,
			top: height / 2 - 16
		});
		editorState.fabricCanvas.add(text);
		editorState.fabricCanvas.setActiveObject(text);
		editorState.fabricCanvas.requestRenderAll();
	}

	export function addRect() {
		if (!editorState.fabricCanvas) return;
		const rect = new Rect({
			width: 200,
			height: 100,
			fill: '#9ca3af',
			left: width / 2 - 100,
			top: height / 2 - 50
		});
		editorState.fabricCanvas.add(rect);
		editorState.fabricCanvas.setActiveObject(rect);
		editorState.fabricCanvas.requestRenderAll();
	}

	/** Insert a default badge centered on the canvas (TASK-87). The badge
	 *  auto-sizes to its label + padding, so we leave width/height to the
	 *  shape's `_syncBounds()`; only the (left, top) center it visually. */
	export function addBadge() {
		if (!editorState.fabricCanvas) return;
		const badge = new Badge({
			label: 'Badge',
			fill: '#10b981',
			fg: '#ffffff'
		});
		// Center on the canvas after auto-sizing fills width/height.
		badge.set({
			left: width / 2 - badge.width / 2,
			top: height / 2 - badge.height / 2
		});
		editorState.fabricCanvas.add(badge);
		editorState.fabricCanvas.setActiveObject(badge);
		editorState.fabricCanvas.requestRenderAll();
	}

	/** Returns true when the image was actually added to the canvas, false
	 * when the underlying Fabric canvas wasn't ready. Callers can use this
	 * to decide whether to emit a success affordance.
	 *
	 * `assetId` (TASK-116): when provided, the image is stamped with
	 * `srcAssetId` so the editor knows it came from the asset library and
	 * the save serializer rewrites `src` back to `asset://{id}` before
	 * persisting. Live editor display stays on the public URL since
	 * Fabric can't fetch `asset://` directly. */
	export async function addImageFromUrl(url: string, assetId?: string): Promise<boolean> {
		if (!editorState.fabricCanvas) return false;
		const img = await FabricImage.fromURL(url);
		// Re-check after the async load — the canvas may have been torn down
		// during FabricImage.fromURL (e.g. navigation).
		if (!editorState.fabricCanvas) return false;
		img.set({
			left: width / 2 - (img.width ?? 100) / 2,
			top: height / 2 - (img.height ?? 100) / 2
		});
		if (assetId) {
			img.set('srcAssetId', assetId);
		}
		editorState.fabricCanvas.add(img);
		editorState.fabricCanvas.setActiveObject(img);
		editorState.fabricCanvas.requestRenderAll();
		return true;
	}

	export function deleteSelected() {
		if (!editorState.fabricCanvas) return;
		const activeObjects = editorState.fabricCanvas.getActiveObjects();
		if (activeObjects.length === 0) return;
		for (const obj of activeObjects) {
			editorState.fabricCanvas.remove(obj);
		}
		editorState.fabricCanvas.discardActiveObject();
		editorState.fabricCanvas.requestRenderAll();
	}

	export function undoAction() {
		if (editorState.fabricCanvas) undo(editorState.fabricCanvas).then(() => syncObjects());
	}

	export function redoAction() {
		if (editorState.fabricCanvas) redo(editorState.fabricCanvas).then(() => syncObjects());
	}

	/**
	 * Nudge every selected object by (dx, dy) pixels. Used by arrow-key
	 * shortcuts in the editor — Shift expands the step from 1 to 10.
	 *
	 * Operates on `getActiveObjects()` so a multi-select selection (TASK-68)
	 * gets every member moved together, not just the active one. Skip when
	 * an IText is in editing mode — the IText itself owns arrow-key
	 * handling for caret movement.
	 */
	export function nudgeSelected(dx: number, dy: number) {
		if (!editorState.fabricCanvas) return;
		const active = editorState.fabricCanvas.getActiveObject();
		if (active && active.type === 'i-text' && (active as IText).isEditing) return;
		const objects = editorState.fabricCanvas.getActiveObjects();
		if (objects.length === 0) return;
		for (const obj of objects) {
			obj.set({ left: (obj.left ?? 0) + dx, top: (obj.top ?? 0) + dy });
			obj.setCoords();
		}
		// ActiveSelection (the parent of multi-selected objects) needs its
		// own bounding box recomputed, otherwise the rotate/scale handles
		// stay where they were before the nudge.
		const activeSelection = editorState.fabricCanvas.getActiveObject();
		if (activeSelection && objects.length > 1) activeSelection.setCoords();
		editorState.fabricCanvas.requestRenderAll();
		markDirty();
	}

	/**
	 * Duplicate every selected object in place, offset by (10, 10) so the
	 * copy is visible. The new copies become the active selection so a
	 * follow-up keystroke (delete, nudge, another duplicate) targets them.
	 *
	 * Uses Fabric's `clone()` which preserves paramBindings + conditional
	 * styles + every other custom prop, since clone() round-trips through
	 * toObject/fromObject under the hood.
	 */
	export async function duplicateSelected() {
		if (!editorState.fabricCanvas) return;
		const objects = editorState.fabricCanvas.getActiveObjects();
		if (objects.length === 0) return;
		// IText editing should not swallow Cmd/Ctrl+D — but we still skip
		// when the user is mid-edit so we don't interrupt typing.
		const active = editorState.fabricCanvas.getActiveObject();
		if (active && active.type === 'i-text' && (active as IText).isEditing) return;
		const clones = await Promise.all(objects.map((o) => o.clone([...EDITOR_TO_OBJECT_PROPS])));
		editorState.fabricCanvas.discardActiveObject();
		for (const clone of clones) {
			clone.set({ left: (clone.left ?? 0) + 10, top: (clone.top ?? 0) + 10 });
			editorState.fabricCanvas.add(clone);
		}
		// Re-select the clones so the next action targets them. Single
		// clone → setActiveObject directly. Multiple clones → wrap them
		// in an ActiveSelection so a follow-up nudge/delete/duplicate
		// hits every duplicate together (Fabric's multi-select).
		if (clones.length === 1) {
			editorState.fabricCanvas.setActiveObject(clones[0]);
		} else if (clones.length > 1) {
			const selection = new ActiveSelection(clones, { canvas: editorState.fabricCanvas });
			editorState.fabricCanvas.setActiveObject(selection);
		}
		editorState.fabricCanvas.requestRenderAll();
	}

	/** Move every selected object forward one z-step. No-op (and no
	 *  markDirty) when nothing is selected — the route always
	 *  preventDefault()s the bracket shortcut, so without this guard a
	 *  spurious press would flag the canvas dirty + trigger autosave. */
	export function bringSelectedForward() {
		if (!editorState.fabricCanvas) return;
		const objects = editorState.fabricCanvas.getActiveObjects();
		if (objects.length === 0) return;
		for (const obj of objects) {
			editorState.fabricCanvas.bringObjectForward(obj);
		}
		// syncObjects() refreshes editorState.objects so the LayerPanel
		// reflects the new order. Without it the panel keeps showing the
		// stale order until any other sync-triggering edit happens.
		syncObjects();
		editorState.fabricCanvas.requestRenderAll();
		markDirty();
	}

	/** Move every selected object backward one z-step. */
	export function sendSelectedBackward() {
		if (!editorState.fabricCanvas) return;
		const objects = editorState.fabricCanvas.getActiveObjects();
		if (objects.length === 0) return;
		for (const obj of objects) {
			editorState.fabricCanvas.sendObjectBackwards(obj);
		}
		syncObjects();
		editorState.fabricCanvas.requestRenderAll();
		markDirty();
	}

	/** Move every selected object to the very top of the z-stack. */
	export function bringSelectedToFront() {
		if (!editorState.fabricCanvas) return;
		const objects = editorState.fabricCanvas.getActiveObjects();
		if (objects.length === 0) return;
		for (const obj of objects) {
			editorState.fabricCanvas.bringObjectToFront(obj);
		}
		syncObjects();
		editorState.fabricCanvas.requestRenderAll();
		markDirty();
	}

	/** Move every selected object to the very bottom of the z-stack. */
	export function sendSelectedToBack() {
		if (!editorState.fabricCanvas) return;
		const objects = editorState.fabricCanvas.getActiveObjects();
		if (objects.length === 0) return;
		for (const obj of objects) {
			editorState.fabricCanvas.sendObjectToBack(obj);
		}
		syncObjects();
		editorState.fabricCanvas.requestRenderAll();
		markDirty();
	}

	/**
	 * Align every selected object inside the bounding rect of the
	 * selection. `mode` picks the axis + edge:
	 *   left / center-h / right (horizontal axis)
	 *   top / center-v / bottom (vertical axis)
	 *
	 * Why discard-then-reselect: when objects are members of an
	 * ActiveSelection, their .left/.top are relative to the selection's
	 * center, not to canvas (0,0). We work in canvas coords via
	 * getBoundingRect() — which returns canvas coords — then mutate the
	 * underlying .left/.top. Discarding first puts the objects back into
	 * canvas-coord space; rebuilding the selection at the end restores
	 * the user's multi-select for follow-up actions.
	 */
	export function alignSelected(
		mode: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom'
	) {
		if (!editorState.fabricCanvas) return;
		const canvas = editorState.fabricCanvas;
		const objects = canvas.getActiveObjects();
		if (objects.length < 2) return;
		// Discard FIRST, then snapshot bounding rects. ActiveSelection
		// children report .left/.top relative to the selection's center,
		// and `getBoundingRect()` reflects that — so reading rects before
		// discardActiveObject returns coords offset by the selection
		// transform, which causes the alignment math to no-op.
		canvas.discardActiveObject();
		// setCoords after the discard so the rects below reflect post-
		// discard transforms.
		for (const o of objects) o.setCoords();
		const rects = objects.map((o) => ({ obj: o, rect: o.getBoundingRect() }));
		const minLeft = Math.min(...rects.map((r) => r.rect.left));
		const maxRight = Math.max(...rects.map((r) => r.rect.left + r.rect.width));
		const minTop = Math.min(...rects.map((r) => r.rect.top));
		const maxBottom = Math.max(...rects.map((r) => r.rect.top + r.rect.height));
		for (const { obj, rect } of rects) {
			let dx = 0;
			let dy = 0;
			if (mode === 'left') dx = minLeft - rect.left;
			else if (mode === 'right') dx = maxRight - (rect.left + rect.width);
			else if (mode === 'center-h') dx = (minLeft + maxRight) / 2 - (rect.left + rect.width / 2);
			else if (mode === 'top') dy = minTop - rect.top;
			else if (mode === 'bottom') dy = maxBottom - (rect.top + rect.height);
			else if (mode === 'center-v') dy = (minTop + maxBottom) / 2 - (rect.top + rect.height / 2);
			obj.set({ left: (obj.left ?? 0) + dx, top: (obj.top ?? 0) + dy });
			obj.setCoords();
		}
		// Deselect after alignment. Re-wrapping into a new ActiveSelection
		// re-stores child .left/.top in selection-relative space, so a
		// follow-up alignment op operates on stale relative coords. Users
		// can shift-click to chain operations; the rare extra click is
		// worth correctness.
		setSelectedObject(null);
		setActiveObjects([]);
		canvas.requestRenderAll();
		markDirty();
	}

	/**
	 * Equally distribute the centers of every selected object along the
	 * given axis. Endpoints stay where the user put them; only the inner
	 * objects move. Needs at least 3 objects (with 2 there's nothing to
	 * distribute — endpoints are already "even").
	 */
	export function distributeSelected(axis: 'h' | 'v') {
		if (!editorState.fabricCanvas) return;
		const canvas = editorState.fabricCanvas;
		const objects = canvas.getActiveObjects();
		if (objects.length < 3) return;
		// Same discard-first pattern as alignSelected — see that comment.
		canvas.discardActiveObject();
		for (const o of objects) o.setCoords();
		const data = objects.map((o) => ({ obj: o, rect: o.getBoundingRect() }));
		if (axis === 'h') {
			data.sort((a, b) => a.rect.left + a.rect.width / 2 - (b.rect.left + b.rect.width / 2));
			const first = data[0].rect;
			const last = data[data.length - 1].rect;
			const startC = first.left + first.width / 2;
			const endC = last.left + last.width / 2;
			const step = (endC - startC) / (data.length - 1);
			for (let i = 1; i < data.length - 1; i++) {
				const targetCenter = startC + step * i;
				const dx = targetCenter - (data[i].rect.left + data[i].rect.width / 2);
				data[i].obj.set({ left: (data[i].obj.left ?? 0) + dx });
				data[i].obj.setCoords();
			}
		} else {
			data.sort((a, b) => a.rect.top + a.rect.height / 2 - (b.rect.top + b.rect.height / 2));
			const first = data[0].rect;
			const last = data[data.length - 1].rect;
			const startC = first.top + first.height / 2;
			const endC = last.top + last.height / 2;
			const step = (endC - startC) / (data.length - 1);
			for (let i = 1; i < data.length - 1; i++) {
				const targetCenter = startC + step * i;
				const dy = targetCenter - (data[i].rect.top + data[i].rect.height / 2);
				data[i].obj.set({ top: (data[i].obj.top ?? 0) + dy });
				data[i].obj.setCoords();
			}
		}
		// Deselect after distribution — see comment in alignSelected.
		setSelectedObject(null);
		setActiveObjects([]);
		canvas.requestRenderAll();
		markDirty();
	}

	/**
	 * Multi-select toggle from a layer-panel click. `additive` true =
	 * shift/cmd-click; the layer is added to (or removed from) the
	 * current selection. False = single-select replacement (the default
	 * row-click behavior).
	 *
	 * Lives here, not in LayerPanel, so the same selection bookkeeping
	 * (ActiveSelection wrapping, syncObjects, setActiveObject) stays in
	 * one place — and so future toolbar buttons can call it too.
	 */
	export function toggleLayerSelection(obj: FabricObject, additive: boolean) {
		if (!editorState.fabricCanvas) return;
		const canvas = editorState.fabricCanvas;
		if (!additive) {
			canvas.setActiveObject(obj);
			// Mirror the selection event handlers — Fabric's setActiveObject
			// fires 'selection:updated' when replacing an existing selection
			// but NOT 'selection:created' when going from no-selection, and
			// the layer-panel relies on activeObjects being current
			// regardless. Setting both here guarantees consistency.
			setSelectedObject(obj);
			setActiveObjects([obj]);
			canvas.requestRenderAll();
			return;
		}
		const existing = canvas.getActiveObjects();
		let next: FabricObject[];
		if (existing.includes(obj)) {
			next = existing.filter((o) => o !== obj);
		} else {
			next = [...existing, obj];
		}
		canvas.discardActiveObject();
		if (next.length === 0) {
			setSelectedObject(null);
			setActiveObjects([]);
		} else if (next.length === 1) {
			canvas.setActiveObject(next[0]);
			setSelectedObject(next[0]);
			setActiveObjects([next[0]]);
		} else {
			const sel = new ActiveSelection(next, { canvas });
			canvas.setActiveObject(sel);
			// Keep selectedObject pointing at a real canvas object (the
			// first member) so the property panel binds to something it
			// can actually edit. ActiveSelection itself is a transient
			// wrapper — editing its props would persist nothing. The full
			// member list lives in activeObjects for the layer panel + the
			// align toolbar.
			setSelectedObject(next[0]);
			setActiveObjects(next);
		}
		canvas.requestRenderAll();
	}

	/** Clear the active selection. Bound to Escape in the global handler. */
	export function deselectAll() {
		if (!editorState.fabricCanvas) return;
		editorState.fabricCanvas.discardActiveObject();
		editorState.fabricCanvas.requestRenderAll();
	}

	function handleKeydown(e: KeyboardEvent) {
		const key = e.key.toLowerCase();
		// Redo: Ctrl+Shift+Z / Cmd+Shift+Z (check before undo since both match 'z')
		if ((e.ctrlKey || e.metaKey) && key === 'z' && e.shiftKey) {
			e.preventDefault();
			redoAction();
			return;
		}
		// Undo: Ctrl+Z / Cmd+Z
		if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
			e.preventDefault();
			undoAction();
			return;
		}
		// Delete selected
		if (e.key === 'Delete' || e.key === 'Backspace') {
			if (!editorState.fabricCanvas) return;
			const active = editorState.fabricCanvas.getActiveObject();
			if (active && active.type === 'i-text' && (active as IText).isEditing) {
				return;
			}
			e.preventDefault();
			deleteSelected();
		}
	}
</script>

<!--
	Two-layer structure for CSS-transform zoom (TASK-150):
	- `.canvas-stage` sizes the layout footprint to canvas × zoom so the
	  scroll container's scrollable area matches what's visible. It
	  carries the visual frame (border/shadow) so the chrome stays
	  crisp at any zoom level.
	- `.canvas-wrapper` keeps its authored width/height (so Fabric's
	  intrinsic coords are untouched) and applies `transform: scale()`
	  with top-left origin so the math is predictable.
-->
<div
	class="canvas-stage"
	style="--canvas-w:{width}px; --canvas-h:{height}px; --canvas-scale:{zoom}"
>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		class="canvas-wrapper"
		bind:this={wrapperEl}
		tabindex="0"
		role="application"
		aria-label="Visual editor canvas"
		onkeydown={handleKeydown}
	>
		{#if !fabricMounted}
			<!-- Skeleton overlay during the 1-2s Fabric init window. Sized to
				the canvas so layout doesn't jump when fabric mounts. -->
			<div
				class="canvas-skeleton"
				role="status"
				aria-live="polite"
				aria-label="Loading editor"
			></div>
		{/if}
		<canvas bind:this={canvasEl}></canvas>
	</div>
</div>

<style>
	.canvas-stage {
		/* Footprint that the scroll container sees. By sizing the stage
		   to (canvas × scale) we make the scrollable region match what
		   the user can actually see, so native overflow scrolling pans
		   correctly at any zoom level. `flex-shrink: 0` keeps the stage
		   at its declared size inside the flex parent — without it the
		   stage gets shrunk to fit the container and the wrapper's
		   transformed visual content extends past the layout box,
		   reproducing the original TASK-150 clipping bug. */
		flex-shrink: 0;
		width: calc(var(--canvas-w) * var(--canvas-scale));
		height: calc(var(--canvas-h) * var(--canvas-scale));
		border: 1px solid var(--color-border);
		border-radius: 4px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
		background: #ffffff;
	}

	.canvas-wrapper {
		position: relative;
		/* Authored canvas dimensions — Fabric draws here at intrinsic
		   coordinates. The visual size on screen is driven by the
		   `transform: scale()` below; layout footprint comes from the
		   parent `.canvas-stage` (sized to canvas × scale). */
		width: var(--canvas-w);
		height: var(--canvas-h);
		transform: scale(var(--canvas-scale));
		transform-origin: top left;
		/* No border / shadow / overflow:hidden here — those moved to
		   `.canvas-stage` so the visual chrome stays crisp and we no
		   longer clip the inner <canvas> when something unexpectedly
		   resizes the wrapper. */
		outline: none;
	}

	.canvas-skeleton {
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			var(--color-surface-muted) 0%,
			var(--color-border) 40%,
			var(--color-surface-muted) 80%,
			var(--color-surface-muted) 100%
		);
		background-size: 200% 100%;
		animation: canvas-shimmer 1.4s ease-in-out infinite;
		pointer-events: none;
		z-index: 1;
	}

	@keyframes canvas-shimmer {
		0% {
			background-position: 100% 0;
		}
		100% {
			background-position: -100% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.canvas-skeleton {
			animation: none;
			background: var(--color-border);
		}
	}

	/* Focus ring goes on the stage now (which carries the visual frame),
	   not the wrapper — putting it on the wrapper would render through
	   the `transform: scale()` and either bloat or shrink with zoom. */
	.canvas-stage:focus-within {
		border-color: var(--color-text-subtle);
		box-shadow:
			0 1px 3px rgba(0, 0, 0, 0.1),
			0 0 0 2px rgba(99, 102, 241, 0.2);
	}
</style>
