<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
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
	import { ConfirmDialog } from '$lib/components/ui';

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
	let canvasScopedSyncId = $state(untrack(() => data.canvas.id));
	$effect(() => {
		if (data.canvas.id !== canvasScopedSyncId) {
			canvasScopedSyncId = data.canvas.id;
			// Resync publish state for the newly loaded canvas.
			isPublished = data.canvas.published;
			// Reset save-failure state so a stale failure from canvas A doesn't
			// bleed into canvas B (wrong red pill + wrong retry toast).
			lastSaveFailed = false;
			if (failedToastId) {
				toast.dismiss(failedToastId);
				failedToastId = null;
			}
			// Clear isSaving. If a save was in flight for canvas A when the user
			// switched, the stale-guard in save() already ignores the returning
			// response for state purposes, but isSaving itself never gets cleared
			// there (intentional — so a late A-response doesn't clobber a B-save
			// in progress). The newly loaded canvas starts from a clean slate.
			isSaving = false;
			// Drop any Test Parameter values entered while previewing canvas A
			// so they don't leak into canvas B's preview when the user opens it.
			// Also close the preview panel if it was open, because
			// collectBoundParams() runs only on togglePreview(); leaving preview
			// open after the switch would show canvas A's binding list (or
			// a spurious "no bindings" state) alongside canvas B's render.
			// Reopening gives the user a fresh, correctly-populated panel.
			testParams = Object.create(null);
			boundParams = [];
			previewQuery = '';
			if (showPreview) {
				showPreview = false;
				previewUrl = '';
				clearTimeout(previewDebounce);
			}
		}
	});
	let showPublishModal = $state(false);
	let openingPublish = $state(false);
	/** Snapshot of the current bindings in the format PublishModal expects.
	 * Only refreshed after any pending edits are persisted — the public
	 * renderer reads templateJson from the DB, so if we snapshotted from live
	 * Fabric state while the canvas was dirty, the "Using this template"
	 * table and example URLs could describe bindings that aren't yet live. */
	let publishBindings = $state<{ name: string; default: string; sourceLabel: string }[]>([]);

	async function openPublishModal() {
		if (openingPublish) return;
		openingPublish = true;
		try {
			await waitForSave();
			if (editorState.isDirty) {
				const saved = await save();
				if (!saved) {
					// The failure toast from save() already tells the user to retry.
					// Abort — opening the modal in a dirty state could mislead about
					// what consumers will actually get.
					return;
				}
			}
			publishBindings = collectBoundParams().map((b) => ({
				name: b.name,
				default: b.default,
				sourceLabel: b.sampleLabel
			}));
			showPublishModal = true;
		} finally {
			openingPublish = false;
		}
	}

	let editorRef: ReturnType<typeof CanvasEditor> | undefined = $state();
	let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
	let isSaving = $state(false);
	/** True when the last save attempt errored out. Cleared on the next
	 * successful save. Drives the persistent "Save failed" indicator and
	 * the sticky error toast. */
	let lastSaveFailed = $state(false);
	/** ID of the sticky error toast so we can dismiss it when the user
	 * either retries successfully or dismisses it manually. */
	let failedToastId = $state<string | null>(null);
	let showPreview = $state(false);
	let previewUrl = $state('');

	/** Derived UI state for the persistent save-status indicator.
	 * Priority order: failed > saving > dirty > saved. */
	type SaveStatus = 'saved' | 'dirty' | 'saving' | 'failed';
	let saveStatus: SaveStatus = $derived.by(() => {
		if (lastSaveFailed) return 'failed';
		if (isSaving) return 'saving';
		if (editorState.isDirty) return 'dirty';
		return 'saved';
	});

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

	// beforeunload warning: protects users from losing work when they close the
	// tab, reload, or navigate to an *external* URL while the editor has unsaved
	// edits, an in-flight save, or a queued/active upload. Modern browsers
	// render their generic "Leave site?" dialog; legacy engines honor returnValue.
	$effect(() => {
		function onBeforeUnload(e: BeforeUnloadEvent) {
			if (hasPendingWork()) {
				e.preventDefault();
				e.returnValue = '';
			}
		}
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => window.removeEventListener('beforeunload', onBeforeUnload);
	});

	// SvelteKit client-side navigation guard. `beforeunload` alone doesn't fire
	// on SPA transitions (e.g. clicking the Dashboard link in the toolbar), so
	// without this the editor would unmount silently and pending work would be
	// lost. We cancel the navigation and show a styled confirm dialog; if the
	// user confirms, we set a one-shot bypass flag and re-issue the goto.
	let pendingNavigationHref = $state<string | null>(null);
	/** True when the blocked destination isn't an app-owned SvelteKit route
	 * (route.id === null) — e.g. external link, non-SvelteKit URL, or
	 * browser-back to an external referrer. Those can't be re-issued via
	 * goto(); they need window.location. */
	let pendingNavigationIsExternal = false;
	let bypassNavigationGuard = false;

	function hasPendingWork(): boolean {
		return editorState.isDirty || isSaving || isUploading;
	}

	beforeNavigate((nav) => {
		if (bypassNavigationGuard) {
			bypassNavigationGuard = false;
			return;
		}
		if (!hasPendingWork()) return;
		const targetHref = nav.to?.url.href;
		if (!targetHref) return;
		pendingNavigationHref = targetHref;
		pendingNavigationIsExternal = nav.to?.route?.id == null;
		nav.cancel();
	});

	function confirmLeave() {
		const href = pendingNavigationHref;
		const external = pendingNavigationIsExternal;
		pendingNavigationHref = null;
		pendingNavigationIsExternal = false;
		if (!href) return;
		bypassNavigationGuard = true;
		if (external) {
			// SvelteKit's goto() only supports app-owned routes. For external or
			// non-SvelteKit destinations we must use window.location, otherwise
			// confirming the dialog throws and the user is trapped.
			window.location.href = href;
		} else {
			goto(href);
		}
	}

	function cancelLeave() {
		pendingNavigationHref = null;
		pendingNavigationIsExternal = false;
	}

	function saveStatusLabel(s: SaveStatus): string {
		switch (s) {
			case 'saved':
				return 'All changes saved';
			case 'dirty':
				return 'Unsaved changes';
			case 'saving':
				return 'Saving…';
			case 'failed':
				return 'Save failed';
		}
	}

	/** Flips false the moment the editor component starts tearing down.
	 * Used to gate late save callbacks — if a save's response arrives after
	 * the user has left /canvas/[id]/edit entirely (data.canvas.id didn't
	 * change, but the component is gone), we must not run handlers that
	 * emit UI (e.g. global retry toast) or touch torn-down state. */
	let isMounted = true;

	// Dismiss any lingering failure toast when the editor unmounts and mark
	// ourselves unmounted so in-flight saves ignore late responses. Without
	// this cleanup: (1) a sticky Retry toast leaks onto unrelated routes,
	// and (2) its Retry action would call save() on a torn-down component.
	$effect(() => {
		return () => {
			isMounted = false;
			if (failedToastId) {
				toast.dismiss(failedToastId);
				failedToastId = null;
			}
		};
	});

	function handleSaveFailure() {
		lastSaveFailed = true;
		// If a previous failure toast is still visible, let it continue to
		// represent the current state instead of stacking a new one.
		if (failedToastId && toast.items.some((t) => t.id === failedToastId)) return;
		failedToastId = toast.error('Could not save your canvas.', {
			action: {
				label: 'Retry',
				onClick: () => {
					failedToastId = null;
					void save();
				}
			}
		});
	}

	function handleSaveSuccess() {
		lastSaveFailed = false;
		if (failedToastId) {
			toast.dismiss(failedToastId);
			failedToastId = null;
		}
	}

	async function save(): Promise<boolean> {
		if (!editorState.fabricCanvas || isSaving) return false;
		isSaving = true;
		// Capture generation before save — only mark clean if no new edits during save
		const genBeforeSave = editorState.editGeneration;
		// Pin the canvas id at request start. If the user navigates to a
		// different /canvas/[id]/edit before the response arrives, we must
		// not flip the new canvas's save-status based on the stale A-response.
		// We also gate on isMounted so a late response that lands after the
		// user has left /canvas/[id]/edit entirely (different route, not a
		// sibling canvas) doesn't leak a retry toast onto unrelated pages.
		const originCanvasId = data.canvas.id;
		const isStale = () => !isMounted || data.canvas.id !== originCanvasId;
		try {
			const json = editorState.fabricCanvas.toObject(['paramBindings']);
			const res = await fetch(`/api/canvas/${originCanvasId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ templateJson: json })
			});
			if (isStale()) return false;
			if (!res.ok) {
				handleSaveFailure();
				return false;
			}
			// Only mark clean if no edits happened during the save
			if (editorState.editGeneration === genBeforeSave) {
				markClean();
			}
			handleSaveSuccess();
			return true;
		} catch {
			if (isStale()) return false;
			handleSaveFailure();
			return false;
		} finally {
			// Only clear isSaving for the originating canvas; if we navigated
			// away, the resync effect already handled teardown of the new
			// canvas's state, and setting isSaving here would be wrong for it
			// (though harmless since save() early-returns if already saving).
			if (!isStale()) isSaving = false;
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
		// Pin the canvas id at *enqueue* time, not when the queued callback
		// eventually runs. Otherwise a batch dropped on canvas A that's still
		// waiting in the chain would read the (by-then current) canvas B when
		// it finally starts.
		const originCanvasId = data.canvas.id;
		uploadChain = uploadChain
			.then(() => uploadAndInsertImage(file, originCanvasId))
			.catch(() => {});
		return uploadChain;
	}

	function openFilePicker() {
		fileInput?.click();
	}

	async function uploadAndInsertImage(file: File, originCanvasId: string) {
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
			if (data.canvas.id !== originCanvasId) {
				// User switched canvases during the upload. The asset is saved to
				// their library but we don't silently inject it into the new canvas.
				toast.info(`"${file.name}" was uploaded but not added — you switched canvases.`);
				return;
			}
			if (!editorRef) {
				// Editor may be unavailable if the user navigated away mid-upload.
				// The upload still succeeded server-side; surface that honestly.
				toast.error('Image uploaded but editor was unavailable — refresh and try again.');
				return;
			}
			const inserted = await editorRef.addImageFromUrl(url);
			if (inserted) {
				toast.success('Image added');
			} else {
				// addImageFromUrl returns false when the Fabric canvas isn't ready
				// (e.g. mount/teardown race). Don't lie about a successful insert.
				toast.error('Image uploaded but could not be added — try again.');
			}
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

	// While the editor is mounted, swallow any file drag-drops that miss the
	// canvas container (toolbar, side panels, empty space). Without this guard,
	// a stray drop would cause the browser to navigate to the dropped file,
	// tearing the user out of the editor and potentially losing unsaved work.
	$effect(() => {
		function block(e: DragEvent) {
			if (hasFileDrag(e)) e.preventDefault();
		}
		window.addEventListener('dragover', block);
		window.addEventListener('drop', block);
		return () => {
			window.removeEventListener('dragover', block);
			window.removeEventListener('drop', block);
		};
	});

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

	// --- Test Parameters panel: drive the preview with bound-param values ---

	interface BoundParamInfo {
		/** Name as it would appear in the URL query string. */
		name: string;
		/** Default value stored on the binding — applied when the URL omits the param. */
		default: string;
		/** Which template property first requested this param (e.g. "Text Content"),
		 * to help the user tell which binding a param drives. */
		sampleLabel: string;
	}

	type FabricLikeObject = {
		paramBindings?: Record<string, { param?: string; default?: string }>;
		type?: string;
	};

	function propLabel(property: string): string {
		switch (property) {
			case 'text':
				return 'Text Content';
			case 'src':
				return 'Image Source';
			case 'fill':
				return 'Fill Color';
			default:
				return property;
		}
	}

	/** Collect a deduped list of {name, default} across every paramBinding in the
	 * current canvas. Two bindings with the same name win with the first-seen
	 * default — matches how the runtime merges. Uses Object.create(null) plus
	 * Object.hasOwn() so identifiers inherited from Object.prototype (e.g.
	 * "constructor", "toString", "hasOwnProperty") aren't misread as already
	 * present and silently dropped. */
	function collectBoundParams(): BoundParamInfo[] {
		if (!editorState.fabricCanvas) return [];
		const json = editorState.fabricCanvas.toObject(['paramBindings']) as {
			objects?: FabricLikeObject[];
		};
		const seen: Record<string, BoundParamInfo> = Object.create(null);
		for (const obj of json.objects ?? []) {
			const bindings = obj.paramBindings;
			if (!bindings) continue;
			for (const [property, binding] of Object.entries(bindings)) {
				// Use the raw stored name — the renderer does params[binding.param]
				// verbatim, so trimming here would show the user a preview URL
				// that doesn't match runtime lookup for names with whitespace.
				// We still skip empty strings since the runtime ignores those.
				const name = binding?.param;
				if (!name) continue;
				if (Object.hasOwn(seen, name)) continue;
				seen[name] = {
					name,
					default: binding?.default ?? '',
					sampleLabel: propLabel(property)
				};
			}
		}
		return Object.values(seen).sort((a, b) => a.name.localeCompare(b.name));
	}

	let boundParams = $state<BoundParamInfo[]>([]);
	/** User-typed test values, keyed by param name. Starts empty (so the default
	 * is applied) and the user types to override. Separate from boundParams so
	 * edits survive re-discovery of bindings. */
	// Null-prototype object so parameter names that collide with Object.prototype
	// members ("constructor", "toString", …) don't shadow inherited properties.
	let testParams = $state<Record<string, string>>(Object.create(null));
	/** The query-string portion driving the preview image, updated only after a
	 * 300ms debounce so the user can type without thrashing the server. */
	let previewQuery = $state('');
	let previewDebounce: ReturnType<typeof setTimeout> | undefined;
	let previewNonce = $state(0);

	function buildPreviewQuery(values: Record<string, string>): string {
		// Build the query string manually (encodeURIComponent) rather than via
		// URLSearchParams to keep eslint-plugin-svelte's reactivity rule happy —
		// this is a pure helper, not a reactive source. Object.entries is safe
		// against prototype pollution (it only yields own enumerable keys).
		const parts: string[] = [];
		for (const [k, v] of Object.entries(values)) {
			if (v === '') continue; // empty means "fall through to binding default"
			parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
		}
		return parts.length ? `&${parts.join('&')}` : '';
	}

	function schedulePreviewRefresh() {
		clearTimeout(previewDebounce);
		previewDebounce = setTimeout(() => {
			previewQuery = buildPreviewQuery(testParams);
			previewNonce++;
		}, 300);
	}

	function setTestParam(name: string, value: string) {
		// Rebuild with a null-prototype object to preserve prototype-pollution
		// safety for identifiers like "constructor" or "toString".
		const next: Record<string, string> = Object.create(null);
		for (const [k, v] of Object.entries(testParams)) next[k] = v;
		next[name] = value;
		testParams = next;
		schedulePreviewRefresh();
	}

	let previewUrlFull = $derived(
		showPreview ? `/api/canvas/${data.canvas.id}/preview?_t=${previewNonce}${previewQuery}` : ''
	);

	async function togglePreview() {
		if (showPreview) {
			showPreview = false;
			previewUrl = '';
			previewQuery = '';
			clearTimeout(previewDebounce);
			return;
		}
		// Wait for any in-flight save, then save again to ensure latest state
		await waitForSave();
		const saved = await save();
		if (!saved) return; // Don't preview if save failed

		// Discover bound params from the freshly-saved template and seed test
		// inputs with empty strings (so defaults take effect). Preserve any
		// existing user-typed values for params that still exist. Uses a
		// null-prototype object so parameter names like "constructor" or
		// "toString" are handled correctly (prototype-pollution safe).
		const discovered = collectBoundParams();
		boundParams = discovered;
		const nextTest: Record<string, string> = Object.create(null);
		for (const p of discovered) {
			nextTest[p.name] = Object.hasOwn(testParams, p.name) ? testParams[p.name] : '';
		}
		testParams = nextTest;

		previewQuery = buildPreviewQuery(testParams);
		previewNonce = Date.now();
		showPreview = true;
	}

	$effect(() => {
		void previewUrlFull;
		previewUrl = previewUrlFull;
	});
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

		<span class="save-indicator save-{saveStatus}" title={saveStatusLabel(saveStatus)}>
			<span class="save-dot" aria-hidden="true"></span>
			<span class="save-label">{saveStatusLabel(saveStatus)}</span>
		</span>

		<button class="save-btn" onclick={save} disabled={isSaving}>
			{isSaving ? 'Saving...' : 'Save'}
		</button>

		<button
			type="button"
			class="publish-btn"
			class:published={isPublished}
			disabled={openingPublish}
			onclick={openPublishModal}
		>
			{openingPublish ? 'Loading…' : isPublished ? 'Published' : 'Publish'}
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

	<ConfirmDialog
		open={pendingNavigationHref !== null}
		title="Leave without saving?"
		message="You have unsaved changes. Leaving now will discard them."
		confirmLabel="Leave anyway"
		cancelLabel="Stay"
		variant="danger"
		onConfirm={confirmLeave}
		onCancel={cancelLeave}
	/>

	<PublishModal
		open={showPublishModal}
		canvasId={data.canvas.id}
		slug={data.canvas.slug}
		published={isPublished}
		bindings={publishBindings}
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
			<div class="preview-body">
				<div class="preview-image">
					<img src={previewUrl} alt="Canvas preview" />
				</div>
				<div class="preview-params">
					<div class="preview-params-header">Test Parameters</div>
					{#if boundParams.length === 0}
						<p class="preview-params-empty">
							No dynamic parameters yet. Select a layer and open
							<strong>Dynamic Parameters</strong> in the property panel to bind one.
						</p>
					{:else}
						<p class="preview-params-hint">
							Type values to preview how the published URL will render. Leave blank to use the
							binding default.
						</p>
						{#each boundParams as p (p.name)}
							<div class="preview-param-row">
								<label class="preview-param-label" for="test-param-{p.name}">
									{p.name}
									<span class="preview-param-source" title="Bound from {p.sampleLabel}">
										{p.sampleLabel}
									</span>
								</label>
								<input
									id="test-param-{p.name}"
									type="text"
									class="preview-param-input"
									value={testParams[p.name] ?? ''}
									oninput={(e) => setTestParam(p.name, e.currentTarget.value)}
									placeholder={p.default || 'default is empty'}
								/>
							</div>
						{/each}
					{/if}
				</div>
			</div>
			<div class="preview-url">
				<code>/c/{data.canvas.slug}/image.png{previewQuery ? `?${previewQuery.slice(1)}` : ''}</code
				>
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

	.save-indicator {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 500;
		padding: 3px 10px;
		border-radius: 9999px;
		white-space: nowrap;
		user-select: none;
	}

	.save-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.save-saved {
		background: #dcfce7;
		color: #15803d;
	}
	.save-saved .save-dot {
		background: #16a34a;
	}

	.save-dirty {
		background: #f1f5f9;
		color: #475569;
	}
	.save-dirty .save-dot {
		background: #94a3b8;
	}

	.save-saving {
		background: #fef3c7;
		color: #92400e;
	}
	.save-saving .save-dot {
		background: #d97706;
		animation: pulse 1s ease-in-out infinite;
	}

	.save-failed {
		background: #fee2e2;
		color: #991b1b;
	}
	.save-failed .save-dot {
		background: #dc2626;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
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

	.preview-body {
		display: flex;
		gap: 20px;
		align-items: flex-start;
		justify-content: center;
	}

	.preview-image {
		flex: 0 1 auto;
		min-width: 0;
	}

	.preview-image img {
		max-width: 100%;
		max-height: 300px;
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.preview-params {
		flex: 0 0 260px;
		text-align: left;
		background: #fff;
		border: 1px solid #e2e8f0;
		border-radius: 6px;
		padding: 10px 12px;
		max-height: 300px;
		overflow-y: auto;
	}

	.preview-params-header {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #64748b;
		margin-bottom: 6px;
	}

	.preview-params-hint {
		font-size: 11px;
		color: #64748b;
		line-height: 1.4;
		margin: 0 0 8px;
	}

	.preview-params-empty {
		font-size: 11.5px;
		color: #64748b;
		line-height: 1.5;
		margin: 0;
	}

	.preview-param-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 8px;
	}

	.preview-param-label {
		font-size: 11px;
		font-weight: 600;
		color: #334155;
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}

	.preview-param-source {
		font-size: 10px;
		font-weight: 400;
		color: #94a3b8;
	}

	.preview-param-input {
		width: 100%;
		padding: 4px 6px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		font-size: 12px;
		font-family: inherit;
		background: #fff;
	}

	.preview-param-input:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18);
	}

	.preview-url {
		margin-top: 12px;
		font-size: 12px;
		color: #64748b;
		text-align: center;
		word-break: break-all;
	}

	.preview-url code {
		background: #e2e8f0;
		padding: 2px 8px;
		border-radius: 3px;
	}
</style>
