<script lang="ts">
	import CanvasEditor from '$lib/components/editor/Canvas.svelte';
	import LayerPanel from '$lib/components/editor/LayerPanel.svelte';
	import PropertyPanel from '$lib/components/editor/PropertyPanel.svelte';
	import {
		isDirty,
		markClean,
		fabricCanvas,
		editGeneration
	} from '$lib/components/editor/state.svelte';
	import { canUndo, canRedo, saveSnapshot } from '$lib/components/editor/history.svelte';

	let { data } = $props();

	let editorRef: ReturnType<typeof CanvasEditor> | undefined = $state();
	let saveStatus: string = $state('');
	let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
	let isSaving = $state(false);

	// Determine background color from data
	let backgroundColor = $derived(
		data.canvas.backgroundType === 'color' ? data.canvas.backgroundValue : '#ffffff'
	);

	// Load template JSON once fabricCanvas is ready
	let hasLoaded = $state(false);
	$effect(() => {
		if (fabricCanvas && !hasLoaded) {
			hasLoaded = true;
			if (data.canvas.templateJson) {
				const json = data.canvas.templateJson;
				fabricCanvas.loadFromJSON(json).then(() => {
					fabricCanvas!.renderAll();
					// Save initial snapshot after hydration so first undo doesn't wipe content
					saveSnapshot(fabricCanvas!);
				});
			} else {
				// Empty canvas — save initial blank snapshot
				saveSnapshot(fabricCanvas);
			}
		}
	});

	// Auto-save: debounce 2 seconds after any edit (watches editGeneration for re-triggers)
	$effect(() => {
		// Read editGeneration to re-run this effect on every new edit
		void editGeneration;
		if (isDirty) {
			clearTimeout(autoSaveTimer);
			autoSaveTimer = setTimeout(() => {
				save();
			}, 2000);
		}

		return () => {
			clearTimeout(autoSaveTimer);
		};
	});

	async function save() {
		if (!fabricCanvas || isSaving) return;
		isSaving = true;
		// Capture generation before save — only mark clean if no new edits during save
		const genBeforeSave = editGeneration;
		try {
			const json = fabricCanvas.toObject(['paramBindings']);
			const res = await fetch(`/api/canvas/${data.canvas.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ templateJson: json })
			});
			if (!res.ok) {
				saveStatus = 'Save failed';
			} else {
				// Only mark clean if no edits happened during the save
				if (editGeneration === genBeforeSave) {
					markClean();
				}
				saveStatus = 'Saved';
			}
		} catch {
			saveStatus = 'Save failed';
		} finally {
			isSaving = false;
			setTimeout(() => {
				saveStatus = '';
			}, 2000);
		}
	}

	function handleAddImage() {
		const url = window.prompt('Enter image URL:');
		if (url) {
			editorRef?.addImageFromUrl(url);
		}
	}
</script>

<svelte:head>
	<title>Edit: {data.canvas.name} | Canvas</title>
</svelte:head>

<div class="editor-layout">
	<header class="toolbar">
		<a href="/" class="back-link">&#8592; Dashboard</a>
		<span class="canvas-name">{data.canvas.name}</span>

		<div class="toolbar-actions">
			<button
				class="tool-btn"
				onclick={() => editorRef?.undoAction()}
				disabled={!canUndo}
				title="Undo (Ctrl+Z)">↩</button
			>
			<button
				class="tool-btn"
				onclick={() => editorRef?.redoAction()}
				disabled={!canRedo}
				title="Redo (Ctrl+Shift+Z)">↪</button
			>
			<span class="toolbar-sep"></span>
			<button class="tool-btn" onclick={() => editorRef?.addText()}>Add Text</button>
			<button class="tool-btn" onclick={() => editorRef?.addRect()}>Add Rectangle</button>
			<button class="tool-btn" onclick={handleAddImage}>Add Image</button>
			<button class="tool-btn delete-btn" onclick={() => editorRef?.deleteSelected()}>
				Delete
			</button>
		</div>

		<div class="spacer"></div>

		{#if saveStatus}
			<span class="save-status">{saveStatus}</span>
		{/if}

		<button class="save-btn" onclick={save} disabled={isSaving}>
			{isSaving ? 'Saving...' : 'Save'}
		</button>

		<span class="publish-badge" class:published={data.canvas.published}>
			{data.canvas.published ? 'Published' : 'Draft'}
		</span>
	</header>

	<div class="main-area">
		<LayerPanel />

		<div class="canvas-container">
			<CanvasEditor
				bind:this={editorRef}
				width={data.canvas.width}
				height={data.canvas.height}
				{backgroundColor}
			/>
		</div>

		<PropertyPanel />
	</div>
</div>

<style>
	.editor-layout {
		display: flex;
		flex-direction: column;
		height: 100vh;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 12px;
		height: 48px;
		padding: 0 16px;
		border-bottom: 1px solid #e2e8f0;
		background: #fff;
		flex-shrink: 0;
	}

	.back-link {
		color: #2563eb;
		text-decoration: none;
		font-size: 14px;
		white-space: nowrap;
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
		max-width: 200px;
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
	}

	.tool-btn:hover {
		background: #f3f4f6;
	}

	.tool-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.toolbar-sep {
		width: 1px;
		height: 20px;
		background: #d1d5db;
		align-self: center;
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

	.save-status {
		font-size: 13px;
		color: #16a34a;
	}

	.save-btn {
		padding: 5px 16px;
		font-size: 13px;
		font-weight: 500;
		border: none;
		border-radius: 4px;
		background: #2563eb;
		color: #fff;
		cursor: pointer;
		white-space: nowrap;
	}

	.save-btn:hover {
		background: #1d4ed8;
	}

	.save-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.publish-badge {
		font-size: 12px;
		padding: 2px 8px;
		border-radius: 9999px;
		background: #f1f5f9;
		color: #9ca3af;
		white-space: nowrap;
	}

	.publish-badge.published {
		background: #dcfce7;
		color: #16a34a;
	}

	.main-area {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.canvas-container {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #f1f5f9;
		overflow: auto;
		padding: 24px;
	}
</style>
