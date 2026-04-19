<script lang="ts">
	import { ConfirmDialog } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';

	let { data } = $props();

	let deletedIds: string[] = $state([]);
	let canvases = $derived(data.canvases.filter((c) => !deletedIds.includes(c.id)));

	let confirmingDelete = $state<{ id: string; name: string } | null>(null);

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
</script>

<svelte:head>
	<title>Dashboard | Canvas</title>
</svelte:head>

<div class="dashboard">
	<header class="header">
		<h1>Your Canvases</h1>
		<a href="/new" class="btn btn-primary">New Canvas</a>
	</header>

	{#if canvases.length === 0}
		<div class="empty">
			<p>You don't have any canvases yet.</p>
			<a href="/new" class="btn btn-primary">Create your first canvas</a>
		</div>
	{:else}
		<div class="grid">
			{#each canvases as canvas (canvas.id)}
				<div class="card">
					<div class="card-body">
						<h2 class="card-title">{canvas.name}</h2>
						<p class="card-dimensions">{canvas.width} &times; {canvas.height}</p>
						<span class="badge" class:published={canvas.published}>
							{canvas.published ? 'Published' : 'Draft'}
						</span>
						<p class="card-meta">Edited {formatRelativeTime(canvas.updatedAt)}</p>
					</div>
					<div class="card-actions">
						<a href="/canvas/{canvas.id}/edit" class="btn btn-edit">Edit</a>
						<button class="btn btn-delete" onclick={() => requestDelete(canvas.id, canvas.name)}>
							Delete
						</button>
					</div>
				</div>
			{/each}
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

	.btn-delete {
		background: none;
		color: #c00;
		padding: 0.5rem 0.75rem;
	}

	.btn-delete:hover {
		background: #fef2f2;
	}

	.empty {
		text-align: center;
		padding: 4rem 1rem;
		color: #666;
	}

	.empty p {
		margin-bottom: 1rem;
		font-size: 1.05rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
	}

	@media (max-width: 900px) {
		.grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (max-width: 550px) {
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

	.card-meta {
		font-size: 0.8rem;
		color: #999;
		margin: 0.5rem 0 0;
	}

	.card-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
</style>
