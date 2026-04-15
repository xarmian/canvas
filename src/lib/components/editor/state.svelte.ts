import type { Canvas, FabricObject } from 'fabric';

/**
 * Shared editor state — bridges Fabric.js imperative canvas
 * with Svelte 5 reactive state ($state runes).
 */

/** The Fabric.js canvas instance */
export let fabricCanvas: Canvas | null = $state(null);

/** Currently selected object (null if nothing selected) */
export let selectedObject: FabricObject | null = $state(null);

/** All objects on the canvas, kept in sync with Fabric */
export let objects: FabricObject[] = $state([]);

/** Whether the canvas has unsaved changes */
export let isDirty: boolean = $state(false);

/** Monotonically increasing edit generation — incremented on every dirty mark */
export let editGeneration: number = $state(0);

/** Sync the objects array from the Fabric canvas */
export function syncObjects() {
	if (!fabricCanvas) {
		objects = [];
		return;
	}
	objects = [...fabricCanvas.getObjects()];
}

/** Mark the canvas as dirty (unsaved changes) */
export function markDirty() {
	isDirty = true;
	editGeneration++;
}

/** Mark the canvas as clean (saved) */
export function markClean() {
	isDirty = false;
}

/** Set the Fabric canvas instance and reset all editor state */
export function setFabricCanvas(canvas: Canvas | null) {
	fabricCanvas = canvas;
	selectedObject = null;
	objects = [];
	isDirty = false;
	editGeneration = 0;
}

/** Set the currently selected object */
export function setSelectedObject(obj: FabricObject | null) {
	selectedObject = obj;
}
