import type { Canvas, FabricObject } from 'fabric';

/**
 * Shared editor state — bridges Fabric.js imperative canvas
 * with Svelte 5 reactive state ($state runes).
 *
 * Svelte 5 doesn't allow exporting reassigned $state from modules.
 * We use a single exported reactive object instead.
 */

/** Optional snapshot callback — set by Canvas component to record undo history */
let snapshotCallback: (() => void) | null = null;

/** Shared reactive editor state object */
export const editorState = $state({
	fabricCanvas: null as Canvas | null,
	selectedObject: null as FabricObject | null,
	/**
	 * All currently-active objects on the canvas — single-select has
	 * length 1, multi-select (Fabric ActiveSelection) has length 2+.
	 * Tracked separately from `selectedObject` because the property panel
	 * is single-object oriented (selectedObject = first), while the
	 * layer panel and the new align toolbar need the whole set.
	 */
	activeObjects: [] as FabricObject[],
	objects: [] as FabricObject[],
	isDirty: false,
	editGeneration: 0,
	/**
	 * True once the current canvas's stored template (if any) has finished
	 * hydrating into Fabric via `loadFromJSON`. The editor page flips this
	 * false at the start of hydration and true on completion. Default
	 * `true` covers the common cases (new canvas with no template, or
	 * the canvas not yet mounted) so panels don't get stuck showing a
	 * loading state when there's nothing to wait for. Used by LayerPanel
	 * to suppress the empty state during the brief window where
	 * `fabricCanvas` exists but `objects` is still empty (TASK-135 Codex
	 * round 1 P2).
	 */
	hydrationComplete: true,
	/**
	 * Visual zoom level for the editor canvas — 1 = 100%, 0.5 = 50%, etc.
	 * This is CSS-transform-based scaling on the canvas wrapper, NOT
	 * Fabric's `setZoom`. Fabric's intrinsic coordinate system stays at
	 * the canvas's authored dimensions (e.g. 1200×630) regardless of
	 * zoom, so exports / save serialization / hit-testing all stay
	 * oblivious. The toolbar reads this for display; Canvas.svelte owns
	 * the actual scaling DOM + ResizeObserver. (TASK-150)
	 */
	zoom: 1,
	/**
	 * Whether zoom auto-recomputes on container resize. 'fit' keeps the
	 * canvas auto-scaled to whatever's visible; 'manual' freezes the
	 * current `zoom` value (user has explicitly chosen a scale via
	 * 100%/wheel/+−). Defaults to 'fit' so a fresh canvas always shows
	 * the full template at any viewport size. (TASK-150)
	 */
	zoomMode: 'fit' as 'fit' | 'manual'
});

/** Hard bounds on user-controlled zoom. Matches Figma's 10%-400% range
 *  so users coming from there don't hit a smaller ceiling. (TASK-150) */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;

/** Register a callback to save undo snapshots (called by Canvas on mount) */
export function setSnapshotCallback(cb: (() => void) | null) {
	snapshotCallback = cb;
}

/** Sync the objects array from the Fabric canvas */
export function syncObjects() {
	if (!editorState.fabricCanvas) {
		editorState.objects = [];
		return;
	}
	editorState.objects = [...editorState.fabricCanvas.getObjects()];
}

/** Mark the canvas as dirty (unsaved changes) and record undo snapshot */
export function markDirty() {
	editorState.isDirty = true;
	editorState.editGeneration++;
	snapshotCallback?.();
}

/** Mark the canvas as clean (saved) */
export function markClean() {
	editorState.isDirty = false;
}

/** Set the Fabric canvas instance and reset all editor state */
export function setFabricCanvas(canvas: Canvas | null) {
	editorState.fabricCanvas = canvas;
	editorState.selectedObject = null;
	editorState.activeObjects = [];
	editorState.objects = [];
	editorState.isDirty = false;
	editorState.editGeneration = 0;
	// Reset to the default — a brand-new mount has no hydration in
	// flight. The editor page will flip this false again if/when it
	// kicks off `loadFromJSON` for a stored template.
	editorState.hydrationComplete = true;
}

/**
 * Flip the hydration flag. The editor page calls this with `false` at
 * the start of `loadFromJSON` and `true` on completion (or `true`
 * immediately when there's no template to load), so panels know
 * whether an empty `objects` array means "nothing yet" or "still
 * hydrating". See LayerPanel's empty-state gate (TASK-135).
 */
export function setHydrationComplete(value: boolean) {
	editorState.hydrationComplete = value;
}

/** Set the currently selected object */
export function setSelectedObject(obj: FabricObject | null) {
	editorState.selectedObject = obj;
}

/**
 * Update the reactive multi-select tracking array. Must be called any
 * time selection:created / selection:updated / selection:cleared fires
 * (or any code path that mutates the canvas's active object) so the
 * layer panel + align toolbar reflect the truth.
 */
export function setActiveObjects(objects: FabricObject[]) {
	editorState.activeObjects = [...objects];
}

/**
 * Mutate editorState.zoom + zoomMode in one place. Clamped to
 * [ZOOM_MIN, ZOOM_MAX]. Canvas.svelte calls this whenever it changes
 * the scale (initial fit, mousewheel, toolbar buttons) so the toolbar's
 * display stays in sync. (TASK-150)
 */
export function setZoomState(zoom: number, mode: 'fit' | 'manual') {
	editorState.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
	editorState.zoomMode = mode;
}
