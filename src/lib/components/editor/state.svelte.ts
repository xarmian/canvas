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
	editorState.objects = [];
	editorState.isDirty = false;
	editorState.editGeneration = 0;
}

/** Set the currently selected object */
export function setSelectedObject(obj: FabricObject | null) {
	editorState.selectedObject = obj;
}
