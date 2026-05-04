<script lang="ts">
	import { onMount } from 'svelte';
	import { Canvas, IText, FabricImage, Rect } from 'fabric';
	import {
		editorState,
		setFabricCanvas,
		setSelectedObject,
		syncObjects,
		markDirty,
		setSnapshotCallback
	} from './state.svelte.ts';
	import { saveSnapshot, undo, redo, resetHistory, historyState } from './history.svelte.ts';
	import { setupSnapping } from './snapping.js';

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

		// Register snapshot callback so markDirty() from any component records history
		setSnapshotCallback(() => {
			if (!historyState.suppressSnapshots) saveSnapshot(canvas);
		});

		// Set up snapping guides
		const cleanupSnapping = setupSnapping(canvas);

		canvas.on('selection:created', (e) => {
			setSelectedObject(e.selected[0] ?? null);
		});

		canvas.on('selection:updated', (e) => {
			setSelectedObject(e.selected[0] ?? null);
		});

		canvas.on('selection:cleared', () => {
			setSelectedObject(null);
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
		};
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

	/** Returns true when the image was actually added to the canvas, false
	 * when the underlying Fabric canvas wasn't ready. Callers can use this
	 * to decide whether to emit a success affordance. */
	export async function addImageFromUrl(url: string): Promise<boolean> {
		if (!editorState.fabricCanvas) return false;
		const img = await FabricImage.fromURL(url);
		// Re-check after the async load — the canvas may have been torn down
		// during FabricImage.fromURL (e.g. navigation).
		if (!editorState.fabricCanvas) return false;
		img.set({
			left: width / 2 - (img.width ?? 100) / 2,
			top: height / 2 - (img.height ?? 100) / 2
		});
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
		const clones = await Promise.all(
			objects.map((o) => o.clone(['paramBindings', 'conditionalStyles']))
		);
		editorState.fabricCanvas.discardActiveObject();
		for (const clone of clones) {
			clone.set({ left: (clone.left ?? 0) + 10, top: (clone.top ?? 0) + 10 });
			editorState.fabricCanvas.add(clone);
		}
		// Re-select the clones so the next action targets them.
		if (clones.length === 1) {
			editorState.fabricCanvas.setActiveObject(clones[0]);
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="canvas-wrapper"
	style="--canvas-w:{width}px; --canvas-h:{height}px"
	bind:this={wrapperEl}
	tabindex="0"
	role="application"
	aria-label="Visual editor canvas"
	onkeydown={handleKeydown}
>
	{#if !fabricMounted}
		<!-- Skeleton overlay during the 1-2s Fabric init window. Sized to
			the canvas so layout doesn't jump when fabric mounts. -->
		<div class="canvas-skeleton" role="status" aria-live="polite" aria-label="Loading editor"></div>
	{/if}
	<canvas bind:this={canvasEl}></canvas>
</div>

<style>
	.canvas-wrapper {
		position: relative;
		display: inline-block;
		/* Reserve space for the actual canvas dimensions BEFORE Fabric
		   mounts. Without this, the wrapper is sized to the bare
		   <canvas> default (300x150), the skeleton is clipped, and
		   layout jumps when Fabric sets real dimensions on mount.
		   No max-width — the parent .canvas-container in the editor
		   route is overflow:auto and is supposed to scroll for large
		   canvases (1080x1080, custom up to 4096). Capping width here
		   would shrink the wrapper, leave Fabric's inner canvas full
		   size, and (with overflow:hidden below) clip rather than
		   scroll. */
		width: var(--canvas-w);
		height: var(--canvas-h);
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
		overflow: hidden;
		outline: none;
	}

	.canvas-skeleton {
		position: absolute;
		inset: 0;
		background: linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 40%, #f1f5f9 80%, #f1f5f9 100%);
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
			background: #e2e8f0;
		}
	}

	.canvas-wrapper:focus-within {
		border-color: #94a3b8;
		box-shadow:
			0 1px 3px rgba(0, 0, 0, 0.1),
			0 0 0 2px rgba(99, 102, 241, 0.2);
	}
</style>
