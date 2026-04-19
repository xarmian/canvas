<script lang="ts">
	import { untrack } from 'svelte';
	import CanvasEditor from '$lib/components/editor/Canvas.svelte';
	import LayerPanel from '$lib/components/editor/LayerPanel.svelte';
	import PropertyPanel from '$lib/components/editor/PropertyPanel.svelte';
	import PublishModal from '$lib/components/editor/PublishModal.svelte';
	import { editorState, markClean } from '$lib/components/editor/state.svelte';
	import {
		historyState,
		saveSnapshot,
		resetHistory,
		beginSuppressSnapshots,
		endSuppressSnapshots
	} from '$lib/components/editor/history.svelte';
	import { toast } from '$lib/stores/toast.svelte';

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
	let publishedSyncId = $state(untrack(() => data.canvas.id));
	$effect(() => {
		if (data.canvas.id !== publishedSyncId) {
			publishedSyncId = data.canvas.id;
			isPublished = data.canvas.published;
		}
	});
	let showPublishModal = $state(false);

	let editorRef: ReturnType<typeof CanvasEditor> | undefined = $state();
	let saveStatus: string = $state('');
	let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
	let isSaving = $state(false);
	let showPreview = $state(false);
	let previewUrl = $state('');

	// Determine background color from data
	let backgroundColor = $derived(
		data.canvas.backgroundType === 'color' ? data.canvas.backgroundValue : '#ffffff'
	);

	// Load template JSON once editorState.fabricCanvas is ready — track by canvas ID
	// Track which hydration is current — incremented on every load to
	// invalidate stale completions from overlapping navigations
	let loadedCanvasId = $state('');
	let hydrationToken = $state(0);
	$effect(() => {
		if (editorState.fabricCanvas && loadedCanvasId !== data.canvas.id) {
			loadedCanvasId = data.canvas.id;
			const thisToken = ++hydrationToken;
			const canvas = editorState.fabricCanvas;

			// Suppress snapshots before clearing to prevent object:removed
			// events from marking dirty and triggering autosave with empty canvas
			beginSuppressSnapshots();

			// Clear canvas and reset state before loading new content
			canvas.clear();
			// Restore background after clear() wipes it
			canvas.backgroundColor = backgroundColor;
			canvas.renderAll();
			resetHistory();
			// Reset dirty flag so autosave doesn't fire for the clear
			markClean();

			if (data.canvas.templateJson) {
				const json = data.canvas.templateJson;
				canvas
					.loadFromJSON(json)
					.then(() => {
						if (hydrationToken !== thisToken) return;
						canvas.renderAll();
					})
					.finally(() => {
						// Only end suppression if this is still the active hydration
						if (hydrationToken !== thisToken) return;
						endSuppressSnapshots();
						saveSnapshot(canvas);
					});
			} else {
				// Empty canvas — end suppression and save initial blank snapshot
				endSuppressSnapshots();
				saveSnapshot(canvas);
			}
		}
	});

	// Auto-save: debounce 2 seconds after any edit (watches editorState.editGeneration for re-triggers)
	$effect(() => {
		// Read editorState.editGeneration to re-run this effect on every new edit
		void editorState.editGeneration;
		if (editorState.isDirty) {
			clearTimeout(autoSaveTimer);
			autoSaveTimer = setTimeout(() => {
				save();
			}, 2000);
		}

		return () => {
			clearTimeout(autoSaveTimer);
		};
	});

	async function save(): Promise<boolean> {
		if (!editorState.fabricCanvas || isSaving) return false;
		isSaving = true;
		// Capture generation before save — only mark clean if no new edits during save
		const genBeforeSave = editorState.editGeneration;
		try {
			const json = editorState.fabricCanvas.toObject(['paramBindings']);
			const res = await fetch(`/api/canvas/${data.canvas.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ templateJson: json })
			});
			if (!res.ok) {
				saveStatus = 'Save failed';
				return false;
			} else {
				// Only mark clean if no edits happened during the save
				if (editorState.editGeneration === genBeforeSave) {
					markClean();
				}
				saveStatus = 'Saved';
				return true;
			}
		} catch {
			saveStatus = 'Save failed';
			return false;
		} finally {
			isSaving = false;
			setTimeout(() => {
				saveStatus = '';
			}, 2000);
		}
	}

	let fileInput = $state<HTMLInputElement | null>(null);
	let isUploading = $state(false);
	let isDraggingFile = $state(false);
	/** Counts nested dragenter/dragleave events so the overlay only clears when
	 * the drag leaves the outer container, not when it moves between children. */
	let dragCounter = 0;
	/** Chain of pending uploads. Each enqueued file awaits the previous one, so
	 * concurrent drops/pickers never stack large parallel POSTs even across
	 * multiple drop events. */
	let uploadChain: Promise<void> = Promise.resolve();

	function queueUpload(file: File) {
		uploadChain = uploadChain.then(() => uploadAndInsertImage(file)).catch(() => {});
		return uploadChain;
	}

	function openFilePicker() {
		fileInput?.click();
	}

	async function uploadAndInsertImage(file: File) {
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
			const { url } = (await res.json()) as { url: string };
			if (!editorRef) {
				// Editor may be unavailable if the user navigated away mid-upload.
				// The upload still succeeded server-side; surface that honestly.
				toast.error('Image uploaded but editor was unavailable — refresh and try again.');
				return;
			}
			await editorRef.addImageFromUrl(url);
			toast.success('Image added');
		} catch {
			toast.error('Upload failed. Check your connection and try again.');
		} finally {
			toast.dismiss(uploadingId);
			isUploading = false;
		}
	}

	function onFileInputChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (file) queueUpload(file);
		// Reset so selecting the same file twice in a row still fires change
		target.value = '';
	}

	function hasFileDrag(e: DragEvent): boolean {
		return Array.from(e.dataTransfer?.types ?? []).includes('Files');
	}

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

	/** Wait for any in-flight save to finish */
	async function waitForSave() {
		while (isSaving) {
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	async function togglePreview() {
		if (showPreview) {
			showPreview = false;
			previewUrl = '';
			return;
		}
		// Wait for any in-flight save, then save again to ensure latest state
		await waitForSave();
		const saved = await save();
		if (!saved) return; // Don't preview if save failed
		// Use authenticated preview endpoint (works for drafts too)
		previewUrl = `/api/canvas/${data.canvas.id}/preview?_t=${Date.now()}`;
		showPreview = true;
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
				disabled={!historyState.canUndo}
				title="Undo (Ctrl+Z)">↩</button
			>
			<button
				class="tool-btn"
				onclick={() => editorRef?.redoAction()}
				disabled={!historyState.canRedo}
				title="Redo (Ctrl+Shift+Z)">↪</button
			>
			<span class="toolbar-sep"></span>
			<button class="tool-btn" onclick={() => editorRef?.addText()}>Add Text</button>
			<button class="tool-btn" onclick={() => editorRef?.addRect()}>Add Rectangle</button>
			<button class="tool-btn" onclick={openFilePicker} disabled={isUploading}>
				{isUploading ? 'Uploading…' : 'Add Image'}
			</button>
			<input
				bind:this={fileInput}
				type="file"
				accept={ACCEPTED_IMAGE_TYPES.join(',')}
				onchange={onFileInputChange}
				style="display: none;"
			/>
			<button class="tool-btn delete-btn" onclick={() => editorRef?.deleteSelected()}>
				Delete
			</button>
		</div>

		<span class="toolbar-sep"></span>
		<button class="tool-btn" class:active={showPreview} onclick={togglePreview}>
			{showPreview ? '✕ Close Preview' : '👁 Preview'}
		</button>

		<div class="spacer"></div>

		{#if saveStatus}
			<span class="save-status">{saveStatus}</span>
		{/if}

		<button class="save-btn" onclick={save} disabled={isSaving}>
			{isSaving ? 'Saving...' : 'Save'}
		</button>

		<button
			type="button"
			class="publish-btn"
			class:published={isPublished}
			onclick={() => (showPublishModal = true)}
		>
			{isPublished ? 'Published' : 'Publish'}
		</button>
	</header>

	<div class="main-area">
		<LayerPanel />

		<div
			class="canvas-container"
			class:drag-over={isDraggingFile}
			ondragenter={onDragEnter}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
			role="region"
			aria-label="Canvas — drop an image here to add it"
		>
			<CanvasEditor
				bind:this={editorRef}
				width={data.canvas.width}
				height={data.canvas.height}
				{backgroundColor}
			/>
			{#if isDraggingFile}
				<div class="drop-overlay" aria-hidden="true">
					<div class="drop-hint">Drop to add image</div>
				</div>
			{/if}
		</div>

		<PropertyPanel />
	</div>

	<PublishModal
		open={showPublishModal}
		canvasId={data.canvas.id}
		slug={data.canvas.slug}
		published={isPublished}
		onClose={() => (showPublishModal = false)}
		onPublishedChange={(next) => (isPublished = next)}
		onBeforePublish={async () => {
			// Flush pending autosave so the published URL renders the latest edits,
			// not whatever was last committed before the user hit Publish.
			await waitForSave();
			if (!editorState.isDirty) return true;
			return await save();
		}}
	/>

	{#if showPreview && previewUrl}
		<div class="preview-panel">
			<div class="preview-header">
				<strong>Rendered Preview</strong>
				<span class="preview-info">
					{data.canvas.width} × {data.canvas.height} · {data.canvas.slug}
				</span>
			</div>
			<div class="preview-image">
				<img src={previewUrl} alt="Canvas preview" />
			</div>
			<div class="preview-url">
				<code>/c/{data.canvas.slug}/image.png</code>
			</div>
		</div>
	{/if}
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
		text-align: center;
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

	.preview-image img {
		max-width: 100%;
		max-height: 300px;
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.preview-url {
		margin-top: 8px;
		font-size: 12px;
		color: #64748b;
	}

	.preview-url code {
		background: #e2e8f0;
		padding: 2px 8px;
		border-radius: 3px;
	}
</style>
