<script lang="ts">
	import { goto } from '$app/navigation';
	import { ConfirmDialog } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { STARTER_CANVAS } from '$lib/templates/starter';
	import EditOrganizationModal from '$lib/components/dashboard/EditOrganizationModal.svelte';

	let { data } = $props();

	let deletedIds: string[] = $state([]);

	/** Local cache of folder/tag edits so the dashboard reflects changes
	 *  immediately after the modal saves — without requiring a full
	 *  invalidate(). Map: canvasId → { folder, tags }. Null folder means
	 *  "uncategorized" (the same as the server). */
	let localEdits: Record<string, { folder: string | null; tags: string[] }> = $state({});

	/** Apply pending deletions + local edits on top of the server data so
	 *  the rest of the page works against a single source of truth. */
	let canvases = $derived(
		data.canvases
			.filter((c) => !deletedIds.includes(c.id))
			.map((c) => {
				const edit = localEdits[c.id];
				if (!edit) return c;
				return { ...c, folder: edit.folder, tags: edit.tags };
			})
	);

	/** Folder list shown in the sidebar — distinct non-null folder values
	 *  from the user's canvases, alphabetically sorted. "All" and
	 *  "Uncategorized" are always present as virtual entries. */
	let folders = $derived(
		Array.from(new Set(canvases.map((c) => c.folder).filter((f): f is string => !!f))).sort(
			(a, b) => a.localeCompare(b)
		)
	);

	/** Selected sidebar entry. `null` = All; '' (empty string) = Uncategorized;
	 *  any other string = that folder name. */
	let selectedFolder = $state<string | null>(null);

	/** Search box value — filters across name + tags, case-insensitive,
	 *  trimmed. Debounce isn't necessary because filtering is cheap and
	 *  $derived recomputation is synchronous. */
	let searchQuery = $state('');

	/** Active tag filter — clicking a tag chip on a card sets this so the
	 *  user can browse "all canvases with this tag." Click again to clear. */
	let activeTag = $state<string | null>(null);

	let visibleCanvases = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		return canvases.filter((c) => {
			if (selectedFolder !== null) {
				if (selectedFolder === '' && c.folder !== null) return false;
				if (selectedFolder !== '' && c.folder !== selectedFolder) return false;
			}
			if (activeTag && !c.tags.includes(activeTag)) return false;
			if (q.length > 0) {
				const haystack = `${c.name} ${c.tags.join(' ')}`.toLowerCase();
				if (!haystack.includes(q)) return false;
			}
			return true;
		});
	});

	let confirmingDelete = $state<{ id: string; name: string } | null>(null);
	let creatingExample = $state(false);
	let duplicatingId = $state<string | null>(null);
	let editingOrg = $state<{
		id: string;
		name: string;
		folder: string | null;
		tags: string[];
	} | null>(null);

	async function tryExample() {
		if (creatingExample) return;
		creatingExample = true;
		try {
			const res = await fetch('/api/canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(STARTER_CANVAS)
			});
			if (!res.ok) {
				toast.error('Could not create example canvas. Try again or start from scratch.');
				return;
			}
			const canvas = (await res.json()) as { id: string };
			goto(`/canvas/${canvas.id}/edit`);
		} catch {
			toast.error('Could not create example canvas. Check your connection and try again.');
		} finally {
			creatingExample = false;
		}
	}

	async function duplicateCanvas(id: string, name: string) {
		if (duplicatingId !== null) return;
		duplicatingId = id;
		try {
			const res = await fetch(`/api/canvas/${id}/duplicate`, { method: 'POST' });
			if (!res.ok) {
				toast.error(`Could not duplicate "${name}". Try again.`);
				return;
			}
			const created = (await res.json()) as { id: string };
			await goto(`/canvas/${created.id}/edit`);
		} catch {
			toast.error(`Could not duplicate "${name}". Check your connection and try again.`);
		} finally {
			duplicatingId = null;
		}
	}

	function formatRelativeTime(date: Date): string {
		const now = new Date();
		const diff = now.getTime() - new Date(date).getTime();
		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) return `${days}d ago`;
		if (hours > 0) return `${hours}h ago`;
		if (minutes > 0) return `${minutes}m ago`;
		return 'just now';
	}

	function requestDelete(id: string, name: string) {
		confirmingDelete = { id, name };
	}

	async function confirmDelete() {
		if (!confirmingDelete) return;
		const { id, name } = confirmingDelete;
		confirmingDelete = null;

		try {
			const res = await fetch(`/api/canvas/${id}`, { method: 'DELETE' });
			if (res.ok) {
				deletedIds.push(id);
				toast.success(`Deleted "${name}"`);
			} else {
				toast.error(`Failed to delete "${name}"`, {
					action: { label: 'Retry', onClick: () => requestDelete(id, name) }
				});
			}
		} catch {
			toast.error(`Failed to delete "${name}"`, {
				action: { label: 'Retry', onClick: () => requestDelete(id, name) }
			});
		}
	}

	function openEditOrg(canvas: {
		id: string;
		name: string;
		folder: string | null;
		tags: string[];
	}) {
		editingOrg = {
			id: canvas.id,
			name: canvas.name,
			folder: canvas.folder,
			tags: canvas.tags
		};
	}

	async function saveOrganization(folder: string | null, tags: string[]) {
		if (!editingOrg) return;
		const id = editingOrg.id;
		const name = editingOrg.name;
		try {
			const res = await fetch(`/api/canvas/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ folder, tags })
			});
			if (!res.ok) {
				toast.error(`Could not save organization for "${name}". Try again.`);
				return;
			}
			localEdits = { ...localEdits, [id]: { folder, tags } };
			editingOrg = null;
		} catch {
			toast.error(`Could not save organization for "${name}". Check your connection.`);
		}
	}

	/** Toggle the active tag filter. Clicking the same chip again clears it. */
	function toggleTagFilter(tag: string) {
		activeTag = activeTag === tag ? null : tag;
	}
</script>

<svelte:head>
	<title>Dashboard | Canvas</title>
</svelte:head>

<div class="dashboard">
	<header class="header">
		<h1>Your Canvases</h1>
		<div class="header-actions">
			<a href="/templates" class="btn btn-secondary">Browse templates</a>
			<a href="/new" class="btn btn-primary">New Canvas</a>
		</div>
	</header>

	{#if canvases.length === 0}
		<div class="empty">
			<h2 class="empty-title">Design once, share anywhere</h2>
			<p class="empty-lede">
				Canvas lets you design a template visually, then generate infinite variants by passing URL
				parameters. Great for OG images, social cards, and any dynamic preview you share.
			</p>
			<ol class="empty-steps">
				<li>Design a template with text and images</li>
				<li>Bind any property to a <code>?name=value</code> URL parameter</li>
				<li>Publish, copy the URL, and share</li>
			</ol>
			<div class="empty-actions">
				<a href="/templates" class="btn btn-primary">Browse templates</a>
				<a href="/new" class="btn btn-secondary">Start from scratch</a>
				<button
					type="button"
					class="btn btn-secondary"
					disabled={creatingExample}
					onclick={tryExample}
				>
					{creatingExample ? 'Loading example…' : 'Try an example'}
				</button>
			</div>
			<p class="empty-hint">
				Templates are ready-to-edit starters for OG cards, podcast covers, blog heroes, and more —
				each one is fully parameterized so you can see the dynamic-image story immediately.
			</p>
		</div>
	{:else}
		<div class="layout">
			<aside class="sidebar" aria-label="Folders">
				<div class="search">
					<input
						type="search"
						placeholder="Search by name or tag"
						bind:value={searchQuery}
						aria-label="Search canvases"
						data-testid="dashboard-search"
					/>
				</div>
				<nav aria-label="Folder filters">
					<ul class="folder-list">
						<li>
							<button
								type="button"
								class="folder-item"
								class:active={selectedFolder === null}
								onclick={() => (selectedFolder = null)}
								data-testid="folder-all"
							>
								<span>All</span>
								<span class="count">{canvases.length}</span>
							</button>
						</li>
						<li>
							<button
								type="button"
								class="folder-item"
								class:active={selectedFolder === ''}
								onclick={() => (selectedFolder = '')}
								data-testid="folder-uncategorized"
							>
								<span>Uncategorized</span>
								<span class="count">{canvases.filter((c) => c.folder === null).length}</span>
							</button>
						</li>
						{#each folders as folder (folder)}
							<li>
								<button
									type="button"
									class="folder-item"
									class:active={selectedFolder === folder}
									onclick={() => (selectedFolder = folder)}
									data-testid="folder-{folder}"
								>
									<span>{folder}</span>
									<span class="count">{canvases.filter((c) => c.folder === folder).length}</span>
								</button>
							</li>
						{/each}
					</ul>
				</nav>
				{#if activeTag}
					<div class="active-tag">
						<span>Tag: <strong>{activeTag}</strong></span>
						<button
							type="button"
							class="active-tag-clear"
							onclick={() => (activeTag = null)}
							aria-label="Clear tag filter"
						>
							Clear
						</button>
					</div>
				{/if}
			</aside>

			<div class="main">
				{#if visibleCanvases.length === 0}
					<p class="empty-results" data-testid="empty-results">No canvases match your filters.</p>
				{:else}
					<div class="grid">
						{#each visibleCanvases as canvas (canvas.id)}
							<div class="card" data-testid="canvas-card" data-canvas-name={canvas.name}>
								<div class="card-body">
									<h2 class="card-title">{canvas.name}</h2>
									<p class="card-dimensions">{canvas.width} &times; {canvas.height}</p>
									<div class="card-badges">
										<span class="badge" class:published={canvas.published}>
											{canvas.published ? 'Published' : 'Draft'}
										</span>
										{#if canvas.folder}
											<span class="badge folder-badge">{canvas.folder}</span>
										{/if}
									</div>
									{#if canvas.tags.length > 0}
										<div class="tags">
											{#each canvas.tags as tag (tag)}
												<button
													type="button"
													class="tag"
													class:active={activeTag === tag}
													onclick={() => toggleTagFilter(tag)}
													data-testid="tag-chip"
												>
													#{tag}
												</button>
											{/each}
										</div>
									{/if}
									<p class="card-meta">Edited {formatRelativeTime(canvas.updatedAt)}</p>
								</div>
								<div class="card-actions">
									<a href="/canvas/{canvas.id}/edit" class="btn btn-edit">Edit</a>
									<button
										class="btn btn-secondary-row"
										data-testid="card-organize"
										onclick={() => openEditOrg(canvas)}
									>
										Organize
									</button>
									<button
										class="btn btn-duplicate"
										data-testid="card-duplicate"
										disabled={duplicatingId !== null}
										onclick={() => duplicateCanvas(canvas.id, canvas.name)}
									>
										{duplicatingId === canvas.id ? 'Duplicating…' : 'Duplicate'}
									</button>
									<button
										class="btn btn-delete"
										onclick={() => requestDelete(canvas.id, canvas.name)}
									>
										Delete
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<ConfirmDialog
	open={confirmingDelete !== null}
	title="Delete canvas?"
	message={confirmingDelete
		? `"${confirmingDelete.name}" will be permanently removed. This can't be undone.`
		: ''}
	confirmLabel="Delete"
	cancelLabel="Cancel"
	variant="danger"
	onConfirm={confirmDelete}
	onCancel={() => (confirmingDelete = null)}
/>

<EditOrganizationModal
	open={editingOrg !== null}
	canvasName={editingOrg?.name ?? ''}
	initialFolder={editingOrg?.folder ?? null}
	initialTags={editingOrg?.tags ?? []}
	knownFolders={folders}
	onSave={saveOrganization}
	onClose={() => (editingOrg = null)}
/>

<style>
	.dashboard {
		max-width: 1100px;
		margin: 0 auto;
		padding: 2rem 1rem;
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 2rem;
	}

	.header h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.layout {
		display: grid;
		grid-template-columns: 220px 1fr;
		gap: 1.5rem;
		align-items: start;
	}

	@media (max-width: 750px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		position: sticky;
		top: 1rem;
	}

	.search input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 0.9rem;
	}

	.folder-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.folder-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		padding: 0.4rem 0.6rem;
		background: none;
		border: 1px solid transparent;
		border-radius: 6px;
		font: inherit;
		font-size: 0.875rem;
		color: #334155;
		cursor: pointer;
		text-align: left;
	}

	.folder-item:hover {
		background: #f1f5f9;
	}

	.folder-item.active {
		background: #0f172a;
		color: #fff;
	}

	.count {
		font-size: 0.75rem;
		color: inherit;
		opacity: 0.7;
	}

	.active-tag {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.4rem 0.6rem;
		background: #fef3c7;
		border: 1px solid #fcd34d;
		border-radius: 6px;
		font-size: 0.85rem;
	}

	.active-tag-clear {
		background: none;
		border: none;
		color: #92400e;
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.15rem 0.35rem;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		text-decoration: none;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.btn:hover {
		opacity: 0.85;
	}

	.btn-primary {
		background: #111;
		color: #fff;
	}

	.btn-edit {
		background: #f0f0f0;
		color: #111;
	}

	.btn-secondary {
		background: #fff;
		color: #111;
		border: 1px solid #d1d5db;
	}

	.btn-secondary:hover {
		background: #f3f4f6;
	}

	.btn-secondary-row {
		background: none;
		color: #334155;
		border: 1px solid #d1d5db;
		padding: 0.5rem 0.75rem;
	}

	.btn-secondary-row:hover {
		background: #f1f5f9;
	}

	.btn-duplicate {
		background: none;
		color: #334155;
		border: 1px solid #d1d5db;
		padding: 0.5rem 0.75rem;
	}

	.btn-duplicate:hover {
		background: #f1f5f9;
	}

	.btn-duplicate:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-delete {
		background: none;
		color: #c00;
		padding: 0.5rem 0.75rem;
	}

	.btn-delete:hover {
		background: #fef2f2;
	}

	.empty {
		max-width: 560px;
		margin: 0 auto;
		text-align: center;
		padding: 3rem 1.5rem;
		color: #334155;
	}

	.empty-title {
		margin: 0 0 0.6rem;
		font-size: 1.5rem;
		font-weight: 700;
		color: #0f172a;
	}

	.empty-lede {
		margin: 0 0 1.25rem;
		font-size: 1rem;
		line-height: 1.55;
		color: #475569;
	}

	.empty-steps {
		margin: 0 auto 1.5rem;
		padding: 0.75rem 1rem 0.75rem 2.5rem;
		text-align: left;
		background: #f8fafc;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		font-size: 0.9rem;
		color: #334155;
		max-width: 420px;
	}

	.empty-steps li {
		margin: 0.2rem 0;
		line-height: 1.5;
	}

	.empty-steps code {
		background: #e2e8f0;
		padding: 0.05rem 0.35rem;
		border-radius: 3px;
		font-size: 0.85em;
	}

	.empty-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.btn-secondary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.empty-hint {
		margin: 0;
		font-size: 0.8125rem;
		color: #94a3b8;
		line-height: 1.5;
	}

	.empty-results {
		text-align: center;
		color: #64748b;
		padding: 2rem 0;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1rem;
	}

	@media (max-width: 1100px) {
		.grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (max-width: 800px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}

	.card {
		border: 1px solid #e5e5e5;
		border-radius: 8px;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		background: #fff;
	}

	.card-body {
		margin-bottom: 1rem;
	}

	.card-title {
		font-size: 1.05rem;
		font-weight: 600;
		margin: 0 0 0.25rem;
	}

	.card-dimensions {
		font-size: 0.85rem;
		color: #888;
		margin: 0 0 0.5rem;
	}

	.card-badges {
		display: flex;
		gap: 0.35rem;
		flex-wrap: wrap;
	}

	.badge {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 500;
		background: #e5e5e5;
		color: #555;
	}

	.badge.published {
		background: #dcfce7;
		color: #166534;
	}

	.folder-badge {
		background: #e0e7ff;
		color: #3730a3;
	}

	.tags {
		display: flex;
		gap: 0.3rem;
		flex-wrap: wrap;
		margin-top: 0.4rem;
	}

	.tag {
		font-size: 0.7rem;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		background: #f1f5f9;
		border: 1px solid #cbd5e1;
		color: #334155;
		cursor: pointer;
	}

	.tag:hover {
		background: #e2e8f0;
	}

	.tag.active {
		background: #fef3c7;
		border-color: #fcd34d;
		color: #92400e;
	}

	.card-meta {
		font-size: 0.8rem;
		color: #999;
		margin: 0.5rem 0 0;
	}

	.card-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
</style>
