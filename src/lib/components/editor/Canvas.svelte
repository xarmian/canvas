<script lang="ts">
	import { onMount } from 'svelte';
	import { Canvas, IText, FabricImage, Rect } from 'fabric';
	import {
		fabricCanvas,
		setFabricCanvas,
		setSelectedObject,
		syncObjects,
		markDirty
	} from './state.svelte.ts';
	import { saveSnapshot, undo, redo, resetHistory, isRestoring } from './history.svelte.ts';
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

	onMount(() => {
		const canvas = new Canvas(canvasEl, {
			width,
			height,
			backgroundColor,
			selection: true
		});

		setFabricCanvas(canvas);
		resetHistory();

		// Set up snapping guides
		const cleanupSnapping = setupSnapping(canvas);

		// Save initial snapshot for undo
		saveSnapshot(canvas);

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
			saveSnapshot(canvas);
		});

		canvas.on('object:added', () => {
			syncObjects();
			markDirty();
			if (!isRestoring) saveSnapshot(canvas);
		});

		canvas.on('object:removed', () => {
			syncObjects();
			markDirty();
			if (!isRestoring) saveSnapshot(canvas);
		});

		return () => {
			cleanupSnapping();
			canvas.dispose();
			setFabricCanvas(null);
			resetHistory();
		};
	});

	export function addText() {
		if (!fabricCanvas) return;
		const text = new IText('Edit me', {
			fontFamily: 'Inter',
			fontSize: 32,
			fill: '#000000',
			left: width / 2 - 60,
			top: height / 2 - 16
		});
		fabricCanvas.add(text);
		fabricCanvas.setActiveObject(text);
		fabricCanvas.requestRenderAll();
	}

	export function addRect() {
		if (!fabricCanvas) return;
		const rect = new Rect({
			width: 200,
			height: 100,
			fill: '#9ca3af',
			left: width / 2 - 100,
			top: height / 2 - 50
		});
		fabricCanvas.add(rect);
		fabricCanvas.setActiveObject(rect);
		fabricCanvas.requestRenderAll();
	}

	export async function addImageFromUrl(url: string) {
		if (!fabricCanvas) return;
		const img = await FabricImage.fromURL(url);
		img.set({
			left: width / 2 - (img.width ?? 100) / 2,
			top: height / 2 - (img.height ?? 100) / 2
		});
		fabricCanvas.add(img);
		fabricCanvas.setActiveObject(img);
		fabricCanvas.requestRenderAll();
	}

	export function deleteSelected() {
		if (!fabricCanvas) return;
		const activeObjects = fabricCanvas.getActiveObjects();
		if (activeObjects.length === 0) return;
		for (const obj of activeObjects) {
			fabricCanvas.remove(obj);
		}
		fabricCanvas.discardActiveObject();
		fabricCanvas.requestRenderAll();
	}

	export function undoAction() {
		if (fabricCanvas) undo(fabricCanvas).then(() => syncObjects());
	}

	export function redoAction() {
		if (fabricCanvas) redo(fabricCanvas).then(() => syncObjects());
	}

	function handleKeydown(e: KeyboardEvent) {
		// Undo: Ctrl+Z / Cmd+Z
		if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
			e.preventDefault();
			undoAction();
			return;
		}
		// Redo: Ctrl+Shift+Z / Cmd+Shift+Z
		if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
			e.preventDefault();
			redoAction();
			return;
		}
		// Delete selected
		if (e.key === 'Delete' || e.key === 'Backspace') {
			if (!fabricCanvas) return;
			const active = fabricCanvas.getActiveObject();
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
	bind:this={wrapperEl}
	tabindex="0"
	role="application"
	aria-label="Visual editor canvas"
	onkeydown={handleKeydown}
>
	<canvas bind:this={canvasEl}></canvas>
</div>

<style>
	.canvas-wrapper {
		position: relative;
		display: inline-block;
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
		overflow: hidden;
		outline: none;
	}

	.canvas-wrapper:focus-within {
		border-color: #94a3b8;
		box-shadow:
			0 1px 3px rgba(0, 0, 0, 0.1),
			0 0 0 2px rgba(99, 102, 241, 0.2);
	}
</style>
