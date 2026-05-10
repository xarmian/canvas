<script lang="ts">
	import { Modal } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { Upload, Library } from '@lucide/svelte';

	interface AssetItem {
		id: string;
		filename: string;
		url: string;
		contentType: string;
		sizeBytes: number;
		createdAt: string | Date;
	}

	interface Props {
		open: boolean;
		/** MIME types accepted by the upload tab. Mirrors the editor's
		 *  ACCEPTED_IMAGE_TYPES so server + client agree. */
		acceptedTypes: readonly string[];
		/** Maximum image size in bytes (used for the client-side guard rail). */
		maxBytes: number;
		onClose: () => void;
		/** Called when the user picks an image (either uploaded or selected
		 *  from the library). The modal hands the URL back so the editor can
		 *  insert it via `addImageFromUrl`.
		 *
		 *  `assetId` (TASK-116) is included whenever the image is library-
		 *  backed — both fresh uploads (we have the id from the response)
		 *  and library picks. The editor stores this on the layer as
		 *  `srcAssetId` so save-time translation can rewrite the persisted
		 *  src to `asset://{id}`. */
		onSelect: (url: string, assetId?: string) => void;
		/** Notifies the parent when an upload starts/finishes inside the
		 *  modal. The editor mirrors this onto its own `isUploading` so the
		 *  beforeunload + beforeNavigate guards still fire while a modal
		 *  upload is in flight — without this hook the guard would let the
		 *  user navigate away mid-upload. */
		onUploadingChange?: (uploading: boolean) => void;
	}

	let { open, acceptedTypes, maxBytes, onClose, onSelect, onUploadingChange }: Props = $props();

	function setUploading(value: boolean) {
		isUploading = value;
		onUploadingChange?.(value);
	}

	type Tab = 'upload' | 'library';
	let activeTab = $state<Tab>('upload');

	// Library state. We fetch on each open() so newly uploaded assets
	// from elsewhere (drag-drop in the editor, /assets page) are picked
	// up without a full page reload. The fetch is silent for re-opens
	// (no spinner) — `library` keeps the previous results visible while
	// the refresh lands.
	let library = $state<AssetItem[]>([]);
	let libraryTotal = $state(0);
	let libraryOffset = $state(0);
	let libraryLoading = $state(false);
	let libraryError = $state(false);
	let libraryLoaded = $state(false);

	let fileInput = $state<HTMLInputElement | null>(null);
	let isUploading = $state(false);

	const PAGE_SIZE = 50;

	$effect(() => {
		if (open) {
			// Refresh on every open so assets uploaded elsewhere (drag-drop
			// in the editor, /assets page) appear without a page reload.
			// Background fetch — no spinner — keeps any cached results
			// visible while the refresh lands. Failure is swallowed; the
			// tab will retry on click via the same loadLibrary path.
			void loadLibrary(0).catch(() => {});
		}
		// Note: we don't clear isUploading on close — an in-flight upload
		// is still in flight, and the parent's hasPendingWork() must keep
		// returning true until the fetch settles. The setUploading(false)
		// call in uploadAndSelect's finally block is the only authoritative
		// signal that the upload is done.
	});

	async function loadLibrary(offset: number) {
		libraryLoading = true;
		libraryError = false;
		try {
			const res = await fetch(`/api/library?offset=${offset}&limit=${PAGE_SIZE}`);
			if (!res.ok) {
				libraryError = true;
				return;
			}
			const body = (await res.json()) as { items: AssetItem[]; total: number };
			library = offset === 0 ? body.items : [...library, ...body.items];
			libraryTotal = body.total;
			libraryOffset = library.length;
			libraryLoaded = true;
		} catch {
			libraryError = true;
		} finally {
			libraryLoading = false;
		}
	}

	function refreshLibrary() {
		libraryLoaded = false;
		library = [];
		libraryOffset = 0;
		void loadLibrary(0);
	}

	function openFilePicker() {
		fileInput?.click();
	}

	async function onFileChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		await uploadAndSelect(file);
	}

	async function uploadAndSelect(file: File) {
		if (!acceptedTypes.includes(file.type)) {
			toast.error(`"${file.name}" is not a supported image. Use PNG, JPEG, WebP, or SVG.`);
			return;
		}
		if (file.size > maxBytes) {
			const maxMb = (maxBytes / (1024 * 1024)).toFixed(0);
			toast.error(`"${file.name}" is larger than ${maxMb}MB. Please use a smaller image.`);
			return;
		}

		setUploading(true);
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
					// non-JSON error — leave detail empty
				}
				toast.error(`Upload failed${detail}`);
				return;
			}
			const body = (await res.json()) as {
				id: string;
				url: string;
				filename: string;
				contentType: string;
				sizeBytes: number;
			};
			// Surface the new asset in the cached library list so the
			// Library tab reflects it without a refetch.
			library = [
				{
					id: body.id,
					filename: body.filename,
					url: body.url,
					contentType: body.contentType,
					sizeBytes: body.sizeBytes,
					createdAt: new Date().toISOString()
				},
				...library
			];
			libraryTotal += 1;
			libraryOffset = library.length;
			libraryLoaded = true;

			onSelect(body.url, body.id);
		} catch {
			toast.error('Upload failed. Check your connection.');
		} finally {
			toast.dismiss(uploadingId);
			setUploading(false);
		}
	}

	function selectFromLibrary(asset: AssetItem) {
		onSelect(asset.url, asset.id);
	}
</script>

<Modal {open} title="Add image" width="36rem" {onClose}>
	<div class="tab-row" role="tablist" aria-label="Add image source">
		<button
			type="button"
			role="tab"
			id="add-image-tab-upload"
			aria-controls="add-image-panel-upload"
			aria-selected={activeTab === 'upload'}
			class:active={activeTab === 'upload'}
			class="tab-btn"
			onclick={() => (activeTab = 'upload')}
		>
			<Upload size={14} aria-hidden="true" />
			<span>Upload new</span>
		</button>
		<button
			type="button"
			role="tab"
			id="add-image-tab-library"
			aria-controls="add-image-panel-library"
			aria-selected={activeTab === 'library'}
			class:active={activeTab === 'library'}
			class="tab-btn"
			onclick={() => {
				activeTab = 'library';
				if (!libraryLoaded && !libraryLoading) void loadLibrary(0);
			}}
		>
			<Library size={14} aria-hidden="true" />
			<span>From library{libraryLoaded ? ` (${libraryTotal})` : ''}</span>
		</button>
	</div>

	{#if activeTab === 'upload'}
		<div
			role="tabpanel"
			id="add-image-panel-upload"
			aria-labelledby="add-image-tab-upload"
			class="upload-panel"
		>
			<p class="lede">PNG, JPEG, WebP, or SVG up to {(maxBytes / (1024 * 1024)).toFixed(0)} MB.</p>
			<button
				type="button"
				class="btn btn-primary"
				onclick={openFilePicker}
				disabled={isUploading}
				data-testid="add-image-upload-btn"
			>
				{isUploading ? 'Uploading…' : 'Choose file'}
			</button>
			<input
				bind:this={fileInput}
				type="file"
				accept={acceptedTypes.join(',')}
				onchange={onFileChange}
				style="display: none;"
			/>
		</div>
	{:else}
		<div
			role="tabpanel"
			id="add-image-panel-library"
			aria-labelledby="add-image-tab-library"
			class="library-panel"
		>
			{#if libraryError && library.length === 0}
				<div class="library-error">
					<p>Couldn't load your asset library.</p>
					<button type="button" class="btn btn-secondary" onclick={refreshLibrary}>Retry</button>
				</div>
			{:else if !libraryLoaded && libraryLoading}
				<p class="library-status">Loading library…</p>
			{:else if library.length === 0}
				<div class="library-empty">
					<p>You haven't uploaded any images yet.</p>
					<button type="button" class="btn btn-secondary" onclick={() => (activeTab = 'upload')}>
						Upload your first image
					</button>
				</div>
			{:else}
				<ul class="library-grid" aria-label="Asset library">
					{#each library as asset (asset.id)}
						<li>
							<button
								type="button"
								class="library-tile"
								onclick={() => selectFromLibrary(asset)}
								aria-label={`Insert ${asset.filename}`}
								data-testid="add-image-library-tile"
							>
								<img src={asset.url} alt="" loading="lazy" />
								<span class="library-filename" title={asset.filename}>{asset.filename}</span>
							</button>
						</li>
					{/each}
				</ul>
				{#if library.length < libraryTotal}
					<div class="library-more">
						<button
							type="button"
							class="btn btn-secondary"
							onclick={() => loadLibrary(libraryOffset)}
							disabled={libraryLoading}
						>
							{libraryLoading
								? 'Loading…'
								: `Load more (${libraryTotal - library.length} remaining)`}
						</button>
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</Modal>

<style>
	.tab-row {
		display: flex;
		gap: 0.25rem;
		border-bottom: 1px solid #e5e7eb;
		margin-bottom: 1rem;
	}

	.tab-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 0.85rem;
		border: none;
		background: transparent;
		font-size: 0.875rem;
		font-weight: 500;
		color: #64748b;
		cursor: pointer;
		border-bottom: 2px solid transparent;
		font-family: inherit;
	}

	.tab-btn:hover {
		color: #1e293b;
	}

	.tab-btn.active {
		color: #1e293b;
		border-bottom-color: #2563eb;
	}

	.tab-btn:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: -2px;
	}

	.upload-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.85rem;
		padding: 1.5rem 1rem;
		text-align: center;
	}

	.lede {
		margin: 0;
		font-size: 0.875rem;
		color: #475569;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
		font-family: inherit;
	}

	.btn-primary {
		background: #2563eb;
		color: #fff;
	}

	.btn-primary:hover {
		background: #1d4ed8;
	}

	.btn-primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-secondary {
		background: #fff;
		color: #1e293b;
		border-color: #d1d5db;
	}

	.btn-secondary:hover {
		background: #f3f4f6;
	}

	.btn-secondary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.library-panel {
		min-height: 240px;
	}

	.library-status,
	.library-error,
	.library-empty {
		padding: 1.5rem 1rem;
		text-align: center;
		color: #475569;
	}

	.library-error p,
	.library-empty p {
		margin: 0 0 0.75rem;
	}

	.library-grid {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 0.6rem;
		max-height: 420px;
		overflow-y: auto;
	}

	.library-tile {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.4rem;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		background: #fff;
		cursor: pointer;
		font-family: inherit;
		text-align: left;
		width: 100%;
	}

	.library-tile:hover {
		border-color: #2563eb;
		background: #f8fafc;
	}

	.library-tile:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 1px;
	}

	.library-tile img {
		display: block;
		width: 100%;
		aspect-ratio: 1 / 1;
		object-fit: contain;
		background: repeating-conic-gradient(#f3f4f6 0% 25%, #fff 0% 50%) 50% / 12px 12px;
		border-radius: 4px;
	}

	.library-filename {
		font-size: 0.7rem;
		color: #475569;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.library-more {
		display: flex;
		justify-content: center;
		margin-top: 1rem;
	}
</style>
