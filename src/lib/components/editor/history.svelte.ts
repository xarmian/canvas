import type { Canvas } from 'fabric';

const MAX_HISTORY = 50;

/** Undo/redo history using canvas JSON snapshots */
let undoStack: string[] = $state([]);
let redoStack: string[] = $state([]);
let isRestoring = $state(false);
let isBusy = $state(false);

/**
 * Whether snapshot recording is suppressed (during hydration or restore).
 * Export so Canvas component events can check before recording.
 */
// eslint-disable-next-line prefer-const
export let suppressSnapshots: boolean = $derived(isRestoring || isBusy);

// eslint-disable-next-line prefer-const
export let canUndo: boolean = $derived(undoStack.length > 1);
// eslint-disable-next-line prefer-const
export let canRedo: boolean = $derived(redoStack.length > 0);

/** Take a snapshot of the current canvas state */
export function saveSnapshot(canvas: Canvas) {
	if (suppressSnapshots) return;

	const json = JSON.stringify(canvas.toObject(['paramBindings']));

	// Don't save if identical to last snapshot
	if (undoStack.length > 0 && undoStack[undoStack.length - 1] === json) return;

	undoStack = [...undoStack.slice(-(MAX_HISTORY - 1)), json];
	redoStack = []; // Clear redo on new action
}

/** Undo: restore the previous state */
/** Monotonic restore token — incremented on every undo/redo and reset.
 *  Used to detect if a canvas switch happened during an async restore. */
let restoreToken = 0;

export async function undo(canvas: Canvas) {
	if (undoStack.length <= 1 || isBusy) return;

	isRestoring = true;
	isBusy = true;
	const token = ++restoreToken;

	const prevUndo = undoStack;
	const prevRedo = redoStack;
	try {
		const current = undoStack[undoStack.length - 1];
		redoStack = [...redoStack, current];
		undoStack = undoStack.slice(0, -1);

		const previous = undoStack[undoStack.length - 1];
		await canvas.loadFromJSON(JSON.parse(previous));
		// Bail if canvas was switched during async restore
		if (restoreToken !== token) return;
		canvas.renderAll();
	} catch {
		if (restoreToken === token) {
			undoStack = prevUndo;
			redoStack = prevRedo;
		}
	} finally {
		if (restoreToken === token) {
			isRestoring = false;
			isBusy = false;
		}
	}
}

/** Redo: restore the next state */
export async function redo(canvas: Canvas) {
	if (redoStack.length === 0 || isBusy) return;

	isRestoring = true;
	isBusy = true;
	const token = ++restoreToken;

	const prevUndo = undoStack;
	const prevRedo = redoStack;
	try {
		const next = redoStack[redoStack.length - 1];
		redoStack = redoStack.slice(0, -1);

		undoStack = [...undoStack, next];
		await canvas.loadFromJSON(JSON.parse(next));
		if (restoreToken !== token) return;
		canvas.renderAll();
	} catch {
		if (restoreToken === token) {
			undoStack = prevUndo;
			redoStack = prevRedo;
		}
	} finally {
		if (restoreToken === token) {
			isRestoring = false;
			isBusy = false;
		}
	}
}

/** Suppress snapshot recording (e.g., during initial hydration) */
export function beginSuppressSnapshots() {
	isRestoring = true;
}

/** Resume snapshot recording */
export function endSuppressSnapshots() {
	isRestoring = false;
}

/** Reset history (e.g., when switching canvases).
 *  Bumps restoreToken to invalidate any in-flight async restores. */
export function resetHistory() {
	restoreToken++;
	undoStack = [];
	redoStack = [];
	isRestoring = false;
	isBusy = false;
}
