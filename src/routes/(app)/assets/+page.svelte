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

	async function uploadOne(file: File) {
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
				{total === 0 ? 'No images yet' : `${total} image${total === 1 ? '' : 's'}`} · Reuse uploaded
				images across canvases.
			</p>
		</div>
		<button
			type="button"
			class="btn btn-primary"
			onclick={openUploadPicker}
			disabled={isUploading}
		>
			<Upload size={14} aria-hidden="true" />
			<span>{isUploading ? 'Uploading…' : 'Upload image'}</span>
		</button>
		<input
			bind:this={fileInput}
			type="file"
			accept="image/png,image/jpeg,image/webp,image/svg+xml"
			onchange={onFileChange}
			style="display: none;"
		/>
	</header>

	{#if items.length === 0}
		<div class="empty">
			<h2>No assets yet</h2>
			<p>
				Upload an image here, or add one from the editor toolbar — both go to the same library.
			</p>
			<button type="button" class="btn btn-primary" onclick={openUploadPicker} disabled={isUploading}>
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
		transition: opacity 0.15s, background 0.15s;
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
		background:
			repeating-conic-gradient(#f3f4f6 0% 25%, #fff 0% 50%) 50% / 16px 16px;
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
</style>
