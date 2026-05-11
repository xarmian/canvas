<script lang="ts">
	import { goto } from '$app/navigation';
	import { ConfirmDialog, EmptyState } from '$lib/components/ui';
	import { SearchX } from '@lucide/svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { getTemplate } from '$lib/templates/gallery';
	import EditOrganizationModal from '$lib/components/dashboard/EditOrganizationModal.svelte';

	/**
	 * Sample URL displayed on the empty-state dashboard (TASK-100). Stays
	 * in lockstep with the LP-card template's bindings so the URL the
	 * user sees is the same one their newly-created canvas will accept.
	 * Uses the public landing's reserved `crypto-lp-card` slug — that
	 * canvas is admin-seeded (HT TASK-118) and is the canonical demo
	 * URL we want first-time users to recognize when they tweet.
	 */
	const SAMPLE_LP_URL = '/c/crypto-lp-card?tokenA=ETH&tokenB=USDC&gainPercent=0.125&boosted=true';

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

	/**
	 * Empty-state primary CTA (TASK-100). Creates a new canvas seeded
	 * from the LP-card gallery template, then drops the user into the
	 * editor. The reserved `crypto-lp-card` slug stays system-owned
	 * (TASK-99 / HT TASK-118), so the user's auto-derived slug becomes
	 * `crypto-lp-card-2` (or higher) — they own that variant, not the
	 * landing-page demo URL.
	 */
	async function startWithLpCard() {
		if (creatingExample) return;
		const lpCard = getTemplate('crypto-lp-card');
		if (!lpCard) {
			// Belt-and-braces — getTemplate returns undefined only if the id
			// is missing from the gallery, which would be a build-time
			// regression. Surface a toast rather than silently no-oping.
			toast.error('LP-card template is unavailable. Try "Browse all templates" instead.');
			return;
		}
		creatingExample = true;
		try {
			const res = await fetch('/api/canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(lpCard.canvas)
			});
			if (!res.ok) {
				toast.error('Could not start the LP card. Try again or start from scratch.');
				return;
			}
			const canvas = (await res.json()) as { id: string };
			goto(`/canvas/${canvas.id}/edit`);
		} catch {
			toast.error('Could not start the LP card. Check your connection and try again.');
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

	/**
	 * Build the absolute share URL for a canvas slug. We use the live
	 * `window.location.origin` rather than a server-injected origin so
	 * preview deployments and self-hosted instances copy the URL the
	 * user is actually browsing — pasting `https://staging.host/c/foo`
	 * into a tweet is correct from staging, and `http://localhost:5173`
	 * is correct from `pnpm dev`.
	 */
	function shareUrlFor(slug: string): string {
		// SSR safety — these handlers only run in the browser, but the
		// $derived expressions above can evaluate during hydration. Guard
		// with a typeof check so a stray render doesn't throw.
		const origin = typeof window !== 'undefined' ? window.location.origin : '';
		return `${origin}/c/${slug}`;
	}

	function imageUrlFor(slug: string): string {
		return `${shareUrlFor(slug)}/image.png`;
	}

	/**
	 * Write `text` to the clipboard and surface success / failure as a
	 * toast. Uses `navigator.clipboard.writeText` (gated to a
	 * user-gesture click handler — Safari requires this). Returns true
	 * on success so callers can keep their UI logic small. */
	async function copyToClipboard(text: string, successMessage: string): Promise<boolean> {
		try {
			if (!navigator.clipboard) {
				toast.error('Clipboard API unavailable. Copy the URL manually from the editor.');
				return false;
			}
			await navigator.clipboard.writeText(text);
			toast.success(successMessage);
			return true;
		} catch {
			// User rejected the permission prompt, or the API threw.
			// Either way the URL didn't make it to the clipboard, so
			// surface a recovery hint instead of silently no-oping.
			toast.error('Could not copy to clipboard. Check browser permissions and try again.');
			return false;
		}
	}

	function copyShareUrl(canvas: { slug: string; published: boolean; name: string }) {
		// Defensive: button is disabled when !published, but a stray
		// programmatic click (DevTools, screen-reader workaround) still
		// gets a clear toast instead of a junk URL.
		if (!canvas.published) {
			toast.info(`Publish "${canvas.name}" first to copy a share URL.`);
			return;
		}
		void copyToClipboard(shareUrlFor(canvas.slug), `Share URL for "${canvas.name}" copied`);
	}

	function copyImageUrl(canvas: { slug: string; published: boolean; name: string }) {
		if (!canvas.published) {
			toast.info(`Publish "${canvas.name}" first to copy an image URL.`);
			return;
		}
		void copyToClipboard(imageUrlFor(canvas.slug), `Image URL for "${canvas.name}" copied`);
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
		<div class="empty" data-testid="empty-state">
			<h2 class="empty-title">Your first dynamic image is one click away.</h2>
			<p class="empty-lede">
				Design a card once, then change the URL to change the image. Start with the LP card and
				you'll see how every value in the URL drives a piece of the render.
			</p>
			<div class="empty-actions">
				<button
					type="button"
					class="btn btn-primary"
					disabled={creatingExample}
					onclick={startWithLpCard}
					data-testid="start-with-lp-card"
				>
					{creatingExample ? 'Starting…' : 'Start with the LP card'}
				</button>
				<a href="/templates" class="btn btn-secondary" data-testid="empty-browse-templates"
					>Browse all templates</a
				>
				<a href="/new" class="btn btn-tertiary" data-testid="empty-start-blank">Start blank</a>
			</div>
			<p class="empty-sample-url-label">Sample URL the LP card answers to:</p>
			<code class="empty-sample-url" data-testid="empty-sample-url">{SAMPLE_LP_URL}</code>
			<p class="empty-hint">
				Each template ships with sensible defaults and named parameters — change one, the image
				changes. No code, no rebuild.
			</p>
			<a href="/assets" class="empty-assets-link" data-testid="empty-assets-link">
				<span class="empty-assets-icon" aria-hidden="true">📁</span>
				<span>
					<strong>Upload logos and images to reuse across canvases</strong>
					<span class="empty-assets-sub"
						>Drop them in your asset library, then drag into any canvas.</span
					>
				</span>
			</a>
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
				<!--
					Assets tile (TASK-103). Surfacing the asset library at the
					bottom of the folders sidebar — the list-row context makes
					"this is a category of stuff you have" obvious, where the
					top-nav link reads as system chrome and gets ignored. The
					count is the user's image-asset total (fonts excluded).
				-->
				<a href="/assets" class="assets-tile" data-testid="dashboard-assets-tile">
					<span class="assets-tile-icon" aria-hidden="true">📁</span>
					<span class="assets-tile-text">
						<span class="assets-tile-label">Assets</span>
						<span class="assets-tile-meta">
							{data.assetCount}
							{data.assetCount === 1 ? 'image' : 'images'} uploaded
						</span>
					</span>
				</a>
			</aside>

			<div class="main">
				{#if visibleCanvases.length === 0}
					<!--
						Filter-empty state — the user has canvases but the
						current search / folder / tag filters returned no
						matches. Use the EmptyState primitive for visual
						consistency with the panel + form-page empty
						surfaces shipped under PLAN-84. The data-testid is
						preserved for the existing e2e selector.
					-->
					<div class="empty-results-wrap" data-testid="empty-results">
						<EmptyState
							icon={SearchX}
							title="No canvases match your filters"
							description="Try clearing the search box, picking a different folder, or removing the active tag."
						/>
					</div>
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
										class="btn btn-copy"
										data-testid="card-copy-share-url"
										disabled={!canvas.published}
										title={canvas.published
											? 'Copy the share page URL'
											: 'Publish this canvas to share.'}
										onclick={() => copyShareUrl(canvas)}
									>
										Copy share URL
									</button>
									<button
										class="btn btn-copy"
										data-testid="card-copy-image-url"
										disabled={!canvas.published}
										title={canvas.published
											? 'Copy the image-only URL'
											: 'Publish this canvas to share.'}
										onclick={() => copyImageUrl(canvas)}
									>
										Copy image URL
									</button>
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
		border: 1px solid var(--color-border-strong);
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
		color: var(--color-text-muted);
		cursor: pointer;
		text-align: left;
	}

	.folder-item:hover {
		background: var(--color-surface-muted);
	}

	.folder-item.active {
		background: var(--color-text);
		color: var(--color-bg);
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
		background: var(--color-warning-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 6px;
		font-size: 0.85rem;
	}

	.active-tag-clear {
		background: none;
		border: none;
		color: var(--color-warning-text);
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
		background: var(--color-text);
		color: var(--color-bg);
	}

	.btn-edit {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.btn-secondary {
		background: var(--color-bg);
		color: var(--color-text);
		border: 1px solid var(--color-border-strong);
	}

	.btn-secondary:hover {
		background: var(--color-surface-muted);
	}

	.btn-secondary-row {
		background: none;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border-strong);
		padding: 0.5rem 0.75rem;
	}

	.btn-copy {
		background: none;
		color: var(--color-primary-hover);
		border: 1px solid var(--color-primary-border);
		padding: 0.5rem 0.75rem;
	}

	.btn-copy:hover:not(:disabled) {
		background: var(--color-primary-surface);
		border-color: var(--color-primary);
	}

	.btn-copy:disabled {
		opacity: 0.55;
		cursor: not-allowed;
		color: var(--color-text-subtle);
		border-color: var(--color-border);
	}

	.btn-secondary-row:hover {
		background: var(--color-surface-muted);
	}

	.btn-duplicate {
		background: none;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border-strong);
		padding: 0.5rem 0.75rem;
	}

	.btn-duplicate:hover {
		background: var(--color-surface-muted);
	}

	.btn-duplicate:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-delete {
		background: none;
		color: var(--color-danger);
		padding: 0.5rem 0.75rem;
	}

	.btn-delete:hover {
		background: var(--color-danger-surface);
	}

	.empty {
		max-width: 560px;
		margin: 0 auto;
		text-align: center;
		padding: 3rem 1.5rem;
		color: var(--color-text-muted);
	}

	.empty-title {
		margin: 0 0 0.6rem;
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-text);
	}

	.empty-lede {
		margin: 0 0 1.25rem;
		font-size: 1rem;
		line-height: 1.55;
		color: var(--color-text-muted);
	}

	.empty-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}

	.empty-sample-url-label {
		margin: 0 0 0.3rem;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 600;
		color: var(--color-text-subtle);
	}

	.empty-sample-url {
		display: inline-block;
		max-width: 100%;
		margin: 0 auto 1rem;
		padding: 0.5rem 0.7rem;
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		color: var(--color-text);
		word-break: break-all;
		text-align: left;
	}

	.btn-tertiary {
		background: none;
		color: var(--color-text-muted);
		border: 1px solid transparent;
		padding: 0.5rem 1rem;
	}

	.btn-tertiary:hover {
		background: var(--color-surface-muted);
		border-color: var(--color-border);
	}

	.btn-primary:disabled,
	.btn-secondary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.empty-assets-link {
		display: inline-flex;
		align-items: center;
		gap: 0.7rem;
		margin-top: 1.25rem;
		padding: 0.7rem 0.9rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		text-decoration: none;
		color: var(--color-text);
		text-align: left;
		max-width: 460px;
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	.empty-assets-link:hover {
		background: var(--color-surface-muted);
		border-color: var(--color-border-strong);
	}

	.empty-assets-icon {
		font-size: 1.4rem;
		line-height: 1;
	}

	.empty-assets-sub {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.8rem;
		color: var(--color-text-subtle);
		font-weight: 400;
	}

	.assets-tile {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.4rem;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		text-decoration: none;
		background: var(--color-bg);
		color: var(--color-text);
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	.assets-tile:hover {
		background: var(--color-surface);
		border-color: var(--color-border-strong);
	}

	.assets-tile-icon {
		font-size: 1.1rem;
		line-height: 1;
	}

	.assets-tile-text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.assets-tile-label {
		font-weight: 600;
		font-size: 0.85rem;
	}

	.assets-tile-meta {
		font-size: 0.75rem;
		color: var(--color-text-subtle);
	}

	.empty-hint {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-subtle);
		line-height: 1.5;
	}

	/* Wrapper for the EmptyState primitive in the filter-empty branch. */
	.empty-results-wrap {
		padding: var(--spacing-8) 0;
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
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		background: var(--color-bg);
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
		color: var(--color-text-subtle);
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
		background: var(--color-border);
		color: var(--color-text-muted);
	}

	.badge.published {
		background: var(--color-success-surface);
		color: var(--color-success-text);
	}

	.folder-badge {
		background: var(--color-primary-surface);
		color: var(--color-primary-hover);
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
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border-strong);
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.tag:hover {
		background: var(--color-border);
	}

	.tag.active {
		background: var(--color-warning-surface);
		border-color: var(--color-warning-border);
		color: var(--color-warning-text);
	}

	.card-meta {
		font-size: 0.8rem;
		color: var(--color-text-subtle);
		margin: 0.5rem 0 0;
	}

	.card-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
</style>
