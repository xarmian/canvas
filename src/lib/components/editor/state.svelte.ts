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
	editGeneration: 0
});

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
