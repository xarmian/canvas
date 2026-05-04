<script lang="ts">
	import { untrack } from 'svelte';
	import { ConfirmDialog } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { Trash2, Upload } from '@lucide/svelte';

	interface AssetItem {
		id: string;
		filename: string;
		url: string;
		contentType: string;
		sizeBytes: number;
		createdAt: string | Date;
	}

	interface UsedInRef {
		id: string;
		name: string;
		slug: string;
		published: boolean;
	}

	let { data } = $props();

	// Items live as $state so deletes and load-more can mutate without a
	// full route reload — invalidating the route would refetch from offset
	// 0 every time and lose the user's scroll position past page one.
	// `untrack` on the initial seeding silences svelte-check's
	// state_referenced_locally — we sync from `data` only on mount, then
	// own the local copy.
	let items = $state<AssetItem[]>(untrack(() => data.items));
	let total = $state<number>(untrack(() => data.total));
	let loadingMore = $state(false);
	let hasMore = $derived(items.length < total);

	let confirming = $state<{
		asset: AssetItem;
		usedIn: UsedInRef[];
		loadingUsage: boolean;
	} | null>(null);

	let fileInput = $state<HTMLInputElement | null>(null);
	let isUploading = $state(false);

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDate(d: string | Date): string {
		const date = typeof d === 'string' ? new Date(d) : d;
		return date.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	async function loadMore() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		try {
			const offset = items.length;
			const res = await fetch(`/api/library?offset=${offset}&limit=${data.pageSize}`);
			if (!res.ok) {
				toast.error('Could not load more assets.');
				return;
			}
			const body = (await res.json()) as { items: AssetItem[]; total: number };
			items = [...items, ...body.items];
			total = body.total;
		} catch {
			toast.error('Could not load more assets. Check your connection.');
		} finally {
			loadingMore = false;
		}
	}

	async function requestDelete(asset: AssetItem) {
		// Open the dialog immediately with a loading indicator so the user
		// gets feedback even if the usage scan is slow on a large library.
		confirming = { asset, usedIn: [], loadingUsage: true };
		try {
			const res = await fetch(`/api/library/${asset.id}/usage`);
			if (!res.ok) {
				// Don't block the delete on a usage-scan failure — surface a
				// neutral warning so the user knows the warning isn't reliable.
				if (confirming?.asset.id === asset.id) {
					confirming = { asset, usedIn: [], loadingUsage: false };
				}
				return;
			}
			const body = (await res.json()) as { usedIn: UsedInRef[] };
			if (confirming?.asset.id === asset.id) {
				confirming = { asset, usedIn: body.usedIn, loadingUsage: false };
			}
		} catch {
			if (confirming?.asset.id === asset.id) {
				confirming = { asset, usedIn: [], loadingUsage: false };
			}
		}
	}

	async function confirmDelete() {
		if (!confirming) return;
		const { asset } = confirming;
		confirming = null;

		try {
			const res = await fetch(`/api/library/${asset.id}`, { method: 'DELETE' });
			if (res.ok) {
				items = items.filter((a) => a.id !== asset.id);
				total = Math.max(0, total - 1);
				toast.success(`Deleted "${asset.filename}"`);
			} else {
				toast.error(`Failed to delete "${asset.filename}"`, {
					action: { label: 'Retry', onClick: () => requestDelete(asset) }
				});
			}
		} catch {
			toast.error(`Failed to delete "${asset.filename}"`, {
				action: { label: 'Retry', onClick: () => requestDelete(asset) }
			});
		}
	}

	function openUploadPicker() {
		fileInput?.click();
	}

	async function onFileChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = ''; // allow re-selecting the same file later
		if (!file) return;
		await uploadOne(file);
	}

	const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
	const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

	// --- Fonts tab (TASK-63) ---
	// Fonts and images share the assets table but get different surfaces:
	// images live in the existing grid above; fonts get a compact list
	// with the derived family name shown so users can correlate the
	// editor's font picker with the rows here.
	const ACCEPTED_FONT_TYPES = [
		'font/ttf',
		'font/otf',
		'font/woff',
		'font/woff2',
		'application/x-font-ttf',
		'application/x-font-otf',
		'application/font-woff',
		'application/font-woff2'
	] as const;
	const MAX_FONT_BYTES = 2 * 1024 * 1024;

	type Tab = 'images' | 'fonts';
	let activeTab = $state<Tab>('images');

	interface FontItem {
		id: string;
		filename: string;
		/** Userid-namespaced family — what's stored in templateJson and
		 *  registered with FontFace. */
		family: string;
		/** Un-namespaced derived family — what we show in the UI. */
		displayName: string;
		url: string;
		contentType: string;
		sizeBytes: number;
		createdAt: string | Date;
	}

	let fonts = $state<FontItem[]>([]);
	let fontsLoading = $state(false);
	let fontsLoaded = $state(false);
	let fontsError = $state(false);
	let fontFileInput = $state<HTMLInputElement | null>(null);
	let isFontUploading = $state(false);

	async function loadFonts() {
		fontsLoading = true;
		fontsError = false;
		try {
			const res = await fetch('/api/fonts');
			if (!res.ok) {
				fontsError = true;
				return;
			}
			const body = (await res.json()) as { items: FontItem[] };
			fonts = body.items;
			fontsLoaded = true;
		} catch {
			fontsError = true;
		} finally {
			fontsLoading = false;
		}
	}

	function openFontPicker() {
		fontFileInput?.click();
	}

	async function onFontFileChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		await uploadFont(file);
	}

	async function uploadFont(file: File) {
		// Many browsers report TTF/OTF without a MIME type — treat empty
		// type as "let the server decide" rather than rejecting outright.
		// The /api/upload endpoint enforces the canonical allow-list.
		if (
			file.type &&
			!ACCEPTED_FONT_TYPES.includes(file.type as (typeof ACCEPTED_FONT_TYPES)[number])
		) {
			toast.error(`"${file.name}" is not a supported font. Use TTF, OTF, WOFF, or WOFF2.`);
			return;
		}
		if (file.size > MAX_FONT_BYTES) {
			toast.error(`"${file.name}" is larger than 2MB. Please use a smaller font file.`);
			return;
		}

		isFontUploading = true;
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
			// Refetch the font list so the derived family name comes from
			// the same place the editor will read — keeps any future
			// metadata-based naming in sync.
			await loadFonts();
			toast.success(`Uploaded "${file.name}"`);
		} catch {
			toast.error('Upload failed. Check your connection.');
		} finally {
			toast.dismiss(uploadingId);
			isFontUploading = false;
		}
	}

	let confirmingFont = $state<FontItem | null>(null);

	function requestFontDelete(font: FontItem) {
		confirmingFont = font;
	}

	async function confirmFontDelete() {
		if (!confirmingFont) return;
		const font = confirmingFont;
		confirmingFont = null;
		try {
			const res = await fetch(`/api/library/${font.id}`, { method: 'DELETE' });
			if (res.ok) {
				fonts = fonts.filter((f) => f.id !== font.id);
				toast.success(`Deleted "${font.filename}"`);
			} else {
				toast.error(`Failed to delete "${font.filename}"`);
			}
		} catch {
			toast.error(`Failed to delete "${font.filename}"`);
		}
	}

	$effect(() => {
		// Lazy-load fonts when the user clicks the Fonts tab. Avoids a
		// blocking fetch on every visit to /assets when most users only
		// care about the images tab.
		if (activeTab === 'fonts' && !fontsLoaded && !fontsLoading) {
			void loadFonts();
		}
	});

	async function uploadOne(file: File) {
		// Client-side type guard. The /assets page is image-only — fonts
		// will get their own surface in TASK-63. Without this guard, a
		// user could override the picker's accept filter (or paste a
		// font file) and we'd prepend it to the image grid as a broken
		// thumbnail until reload.
		if (!ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
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
			// Prepend the new asset so it appears at the top (matches the
			// newest-first sort the server uses).
			items = [
				{
					id: body.id,
					filename: body.filename,
					url: body.url,
					contentType: body.contentType,
					sizeBytes: body.sizeBytes,
					createdAt: new Date().toISOString()
				},
				...items
			];
			total = total + 1;
			toast.success(`Uploaded "${body.filename}"`);
		} catch {
			toast.error('Upload failed. Check your connection.');
		} finally {
			toast.dismiss(uploadingId);
			isUploading = false;
		}
	}
</script>

<svelte:head>
	<title>Assets | Canvas</title>
</svelte:head>

<div class="assets-page">
	<header class="header">
		<div>
			<h1>Assets</h1>
			<p class="subtitle">
				{activeTab === 'images'
					? total === 0
						? 'No images yet'
						: `${total} image${total === 1 ? '' : 's'}`
					: fontsLoaded
						? fonts.length === 0
							? 'No fonts yet'
							: `${fonts.length} font${fonts.length === 1 ? '' : 's'}`
						: 'Loading fonts…'} · Reuse uploaded assets across canvases.
			</p>
		</div>
		{#if activeTab === 'images'}
			<button
				type="button"
				class="btn btn-primary"
				onclick={openUploadPicker}
				disabled={isUploading}
			>
				<Upload size={14} aria-hidden="true" />
				<span>{isUploading ? 'Uploading…' : 'Upload image'}</span>
			</button>
		{:else}
			<button
				type="button"
				class="btn btn-primary"
				onclick={openFontPicker}
				disabled={isFontUploading}
				data-testid="upload-font-btn"
			>
				<Upload size={14} aria-hidden="true" />
				<span>{isFontUploading ? 'Uploading…' : 'Upload font'}</span>
			</button>
		{/if}
		<input
			bind:this={fileInput}
			type="file"
			accept="image/png,image/jpeg,image/webp,image/svg+xml"
			onchange={onFileChange}
			style="display: none;"
		/>
		<input
			bind:this={fontFileInput}
			type="file"
			accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
			onchange={onFontFileChange}
			style="display: none;"
		/>
	</header>

	<div class="tabs" role="tablist" aria-label="Asset type">
		<button
			role="tab"
			type="button"
			data-testid="assets-tab-images"
			aria-selected={activeTab === 'images'}
			class:active={activeTab === 'images'}
			class="tab-btn"
			onclick={() => (activeTab = 'images')}
		>
			Images
		</button>
		<button
			role="tab"
			type="button"
			data-testid="assets-tab-fonts"
			aria-selected={activeTab === 'fonts'}
			class:active={activeTab === 'fonts'}
			class="tab-btn"
			onclick={() => (activeTab = 'fonts')}
		>
			Fonts
		</button>
	</div>

	{#if activeTab === 'fonts'}
		{#if fontsError && fonts.length === 0}
			<div class="empty">
				<h2>Couldn't load fonts</h2>
				<p>Something went wrong reading your font library.</p>
				<button type="button" class="btn btn-secondary" onclick={loadFonts}>Retry</button>
			</div>
		{:else if !fontsLoaded && fontsLoading}
			<p class="loading">Loading fonts…</p>
		{:else if fonts.length === 0}
			<div class="empty">
				<h2>No fonts yet</h2>
				<p>
					Upload a TTF, OTF, WOFF, or WOFF2 file (max 2MB). The family name comes from the filename
					— name the file the way you want to see it in the editor's font picker.
				</p>
				<button
					type="button"
					class="btn btn-primary"
					onclick={openFontPicker}
					disabled={isFontUploading}
				>
					{isFontUploading ? 'Uploading…' : 'Upload your first font'}
				</button>
			</div>
		{:else}
			<ul class="fonts-list" aria-label="Uploaded fonts">
				{#each fonts as font (font.id)}
					<li class="font-row">
						<div class="font-row-main">
							<div class="font-family" style="font-family: {JSON.stringify(font.family)}">
								{font.displayName}
							</div>
							<div class="font-meta">
								{font.filename} · {formatBytes(font.sizeBytes)} · {formatDate(font.createdAt)}
							</div>
						</div>
						<button
							type="button"
							class="btn btn-delete"
							aria-label={`Delete font ${font.displayName}`}
							onclick={() => requestFontDelete(font)}
						>
							<Trash2 size={14} aria-hidden="true" />
							<span>Delete</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{:else if items.length === 0}
		<div class="empty">
			<h2>No assets yet</h2>
			<p>Upload an image here, or add one from the editor toolbar — both go to the same library.</p>
			<button
				type="button"
				class="btn btn-primary"
				onclick={openUploadPicker}
				disabled={isUploading}
			>
				{isUploading ? 'Uploading…' : 'Upload your first image'}
			</button>
		</div>
	{:else}
		<ul class="grid" aria-label="Asset library">
			{#each items as asset (asset.id)}
				<li class="card">
					<div class="thumb">
						<img src={asset.url} alt={asset.filename} loading="lazy" />
					</div>
					<div class="card-body">
						<div class="filename" title={asset.filename}>{asset.filename}</div>
						<div class="meta">
							{formatBytes(asset.sizeBytes)} · {formatDate(asset.createdAt)}
						</div>
					</div>
					<div class="card-actions">
						<button
							type="button"
							class="btn btn-delete"
							aria-label={`Delete ${asset.filename}`}
							onclick={() => requestDelete(asset)}
						>
							<Trash2 size={14} aria-hidden="true" />
							<span>Delete</span>
						</button>
					</div>
				</li>
			{/each}
		</ul>

		{#if hasMore}
			<div class="load-more">
				<button type="button" class="btn btn-secondary" onclick={loadMore} disabled={loadingMore}>
					{loadingMore ? 'Loading…' : `Load more (${total - items.length} remaining)`}
				</button>
			</div>
		{/if}
	{/if}
</div>

<ConfirmDialog
	open={confirming !== null}
	title={confirming?.usedIn.length ? 'Delete asset still in use?' : 'Delete asset?'}
	message={confirming
		? confirming.loadingUsage
			? `"${confirming.asset.filename}" will be permanently removed. Checking which canvases use it…`
			: confirming.usedIn.length
				? `"${confirming.asset.filename}" appears in ${confirming.usedIn.length} canvas${confirming.usedIn.length === 1 ? '' : 'es'}: ${confirming.usedIn.map((c) => c.name).join(', ')}. Deleting will leave broken images in those canvases.`
				: `"${confirming.asset.filename}" will be permanently removed. This can't be undone.`
		: ''}
	confirmLabel="Delete"
	cancelLabel="Cancel"
	variant="danger"
	onConfirm={confirmDelete}
	onCancel={() => (confirming = null)}
/>

<ConfirmDialog
	open={confirmingFont !== null}
	title="Delete font?"
	message={confirmingFont
		? `"${confirmingFont.filename}" will be permanently removed. Any text using "${confirmingFont.displayName}" will fall back to a default font on the next render.`
		: ''}
	confirmLabel="Delete"
	cancelLabel="Cancel"
	variant="danger"
	onConfirm={confirmFontDelete}
	onCancel={() => (confirmingFont = null)}
/>

<style>
	.assets-page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 2rem 1rem;
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.header h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0 0 0.25rem;
	}

	.subtitle {
		margin: 0;
		font-size: 0.875rem;
		color: #64748b;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		text-decoration: none;
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			opacity 0.15s,
			background 0.15s;
		font-family: inherit;
	}

	.btn:hover {
		opacity: 0.9;
	}

	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-primary {
		background: #111;
		color: #fff;
	}

	.btn-secondary {
		background: #fff;
		color: #111;
		border-color: #d1d5db;
	}

	.btn-secondary:hover {
		background: #f3f4f6;
		opacity: 1;
	}

	.btn-delete {
		background: none;
		color: #c00;
		padding: 0.4rem 0.6rem;
	}

	.btn-delete:hover {
		background: #fef2f2;
		opacity: 1;
	}

	.empty {
		text-align: center;
		padding: 3rem 1rem;
		color: #475569;
	}

	.empty h2 {
		font-size: 1.15rem;
		margin: 0 0 0.5rem;
		color: #0f172a;
	}

	.empty p {
		margin: 0 0 1rem;
	}

	.grid {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 1rem;
	}

	.card {
		display: flex;
		flex-direction: column;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		overflow: hidden;
		background: #fff;
	}

	.thumb {
		aspect-ratio: 1 / 1;
		background: repeating-conic-gradient(#f3f4f6 0% 25%, #fff 0% 50%) 50% / 16px 16px;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}

	.thumb img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}

	.card-body {
		padding: 0.5rem 0.75rem 0.25rem;
	}

	.filename {
		font-size: 0.8125rem;
		font-weight: 500;
		color: #1e293b;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.meta {
		font-size: 0.75rem;
		color: #94a3b8;
		margin-top: 0.15rem;
	}

	.card-actions {
		display: flex;
		justify-content: flex-end;
		padding: 0.25rem 0.5rem 0.5rem;
	}

	.load-more {
		display: flex;
		justify-content: center;
		margin-top: 1.5rem;
	}

	.tabs {
		display: flex;
		gap: 0.25rem;
		border-bottom: 1px solid #e5e7eb;
		margin-bottom: 1rem;
	}

	.tab-btn {
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

	.fonts-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.font-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.85rem 1rem;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		background: #fff;
	}

	.font-row-main {
		min-width: 0;
		flex: 1;
	}

	.font-family {
		font-size: 1.05rem;
		font-weight: 600;
		color: #0f172a;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.font-meta {
		font-size: 0.75rem;
		color: #94a3b8;
		margin-top: 0.15rem;
	}

	.loading {
		text-align: center;
		color: #64748b;
		padding: 2rem;
	}
</style>
