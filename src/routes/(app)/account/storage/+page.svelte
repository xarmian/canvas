<script lang="ts">
	import { Button, ConfirmDialog, EmptyState } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { invalidateAll } from '$app/navigation';
	import { HardDrive } from '@lucide/svelte';

	let { data } = $props();

	// Bulk-delete flow state. `bulkInFlight` blocks the close-modal
	// path while requests are still running so a stray Escape can't
	// double-fire the loop. The Modal's `dismissible={false}` in our
	// confirm-dialog wrapper already takes care of backdrop/Escape;
	// `bulkInFlight` is the belt-and-braces guard for the button.
	let confirmOpen = $state(false);
	let bulkInFlight = $state(false);

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const kib = bytes / 1024;
		if (kib < 1024) return `${kib.toFixed(1)} KB`;
		const mib = kib / 1024;
		if (mib < 1024) return `${mib.toFixed(2)} MB`;
		return `${(mib / 1024).toFixed(2)} GB`;
	}

	function formatRelative(value: string | null): string {
		if (!value) return '—';
		const date = new Date(value);
		const diffMs = Date.now() - date.getTime();
		if (diffMs < 60_000) return 'just now';
		const min = Math.floor(diffMs / 60_000);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const day = Math.floor(hr / 24);
		if (day < 30) return `${day}d ago`;
		const mo = Math.floor(day / 30);
		if (mo < 12) return `${mo}mo ago`;
		return `${Math.floor(mo / 12)}y ago`;
	}

	const usagePercent = $derived(
		data.quota > 0 ? Math.min(100, (data.stats.renderCount / data.quota) * 100) : 0
	);
	const quotaTone = $derived.by(() => {
		if (usagePercent >= 95) return 'red';
		if (usagePercent >= 80) return 'amber';
		return 'green';
	});

	async function bulkDeleteAll() {
		if (bulkInFlight) return;
		bulkInFlight = true;
		try {
			// One-shot session-cookie endpoint that soft-deletes every live
			// row in a single UPDATE. We deliberately don't drive this from
			// a client-side loop over the bearer-gated `DELETE
			// /api/v1/renders/{shortId}` endpoint — that would require the
			// user's API-key plaintext (we don't have it), and a per-row
			// loop would also race itself if the user double-clicked.
			const res = await fetch('/api/account/storage/bulk-delete', { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				toast.error(body?.message ?? `Could not delete renders (HTTP ${res.status})`);
				return;
			}
			const { deleted } = (await res.json()) as { deleted: number };
			toast.success(`Deleted ${deleted} render${deleted === 1 ? '' : 's'}`);
			confirmOpen = false;
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Network error');
		} finally {
			bulkInFlight = false;
		}
	}
</script>

<svelte:head>
	<title>Storage · Canvas</title>
</svelte:head>

<div class="page-header">
	<div>
		<h2 class="section-title">Rendered images storage</h2>
		<p class="section-blurb">
			Track how much of your render quota you're using. Each baked render lives at <code
				>/i/&lt;shortId&gt;</code
			>
			until you (or the sweep job) delete it.
		</p>
	</div>
	{#if data.stats.renderCount > 0}
		<Button variant="danger" onclick={() => (confirmOpen = true)} data-testid="bulk-delete-renders">
			Delete all renders
		</Button>
	{/if}
</div>

<div class="stat-grid" data-testid="storage-stats">
	<div class="stat">
		<div class="stat-label">Renders</div>
		<div class="stat-value" data-testid="stat-count">
			{data.stats.renderCount}
			<span class="stat-divider">/</span><span class="stat-quota">{data.quota}</span>
		</div>
		<div class="progress" aria-label="Quota usage">
			<div
				class="progress-fill progress-{quotaTone}"
				style:width="{usagePercent}%"
				data-testid="quota-bar"
			></div>
		</div>
	</div>
	<div class="stat">
		<div class="stat-label">Total storage</div>
		<div class="stat-value" data-testid="stat-bytes">{formatBytes(data.stats.totalBytes)}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Oldest render</div>
		<div class="stat-value">{formatRelative(data.stats.oldestCreatedAt)}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Most recently used</div>
		<div class="stat-value">{formatRelative(data.stats.mostRecentAccessAt)}</div>
	</div>
</div>

{#if data.stats.renderCount === 0}
	<EmptyState
		icon={HardDrive}
		title="No renders yet"
		description="Once you POST to /api/v1/renders, baked images show up here so you can track usage and clean up old ones."
	/>
{:else}
	<div class="card">
		<header class="card-header">
			<h3>Recently used</h3>
			<p class="card-blurb">Last 10 renders sorted by access time.</p>
		</header>
		<table class="recent-table" data-testid="recent-renders">
			<thead>
				<tr>
					<th scope="col">Short ID</th>
					<th scope="col">Canvas</th>
					<th scope="col">Format</th>
					<th scope="col">Size</th>
					<th scope="col">Created</th>
					<th scope="col">Last used</th>
				</tr>
			</thead>
			<tbody>
				{#each data.recent as row (row.shortId)}
					<tr>
						<td>
							<a href="/i/{row.shortId}" target="_blank" rel="noopener" class="short-id-link">
								{row.shortId}
							</a>
						</td>
						<td>{row.canvasName ?? '—'}</td>
						<td><code>{row.format}</code></td>
						<td>{formatBytes(row.sizeBytes)}</td>
						<td>{formatRelative(row.createdAt)}</td>
						<td>{formatRelative(row.lastAccessedAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<ConfirmDialog
	open={confirmOpen}
	title="Delete all renders"
	message={`Delete all ${data.stats.renderCount} render${data.stats.renderCount === 1 ? '' : 's'}? Storage will be freed and /i/<shortId> URLs will stop working. This cannot be undone.`}
	confirmLabel={bulkInFlight ? 'Deleting…' : 'Delete all renders'}
	cancelLabel="Cancel"
	variant="danger"
	onConfirm={bulkDeleteAll}
	onCancel={() => {
		if (!bulkInFlight) confirmOpen = false;
	}}
/>

<style>
	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--spacing-4);
	}

	.section-title {
		font-size: var(--text-xl);
		font-weight: 600;
		margin: 0 0 var(--spacing-1);
	}

	.section-blurb {
		color: var(--color-text-muted);
		margin: 0;
		max-width: 44rem;
		line-height: 1.4;
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--spacing-4);
	}

	.stat {
		background: var(--color-surface-muted);
		border-radius: var(--radius-lg);
		padding: var(--spacing-4);
		display: grid;
		gap: var(--spacing-2);
	}

	.stat-label {
		color: var(--color-text-muted);
		font-size: var(--text-sm);
		font-weight: 500;
	}

	.stat-value {
		font-size: var(--text-2xl);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.stat-divider {
		color: var(--color-text-muted);
		font-weight: 400;
		margin: 0 var(--spacing-1);
	}

	.stat-quota {
		color: var(--color-text-muted);
		font-size: var(--text-lg);
		font-weight: 500;
	}

	.progress {
		height: 6px;
		background: var(--color-border);
		border-radius: 999px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		border-radius: 999px;
		transition: width 0.2s ease;
	}

	.progress-green {
		background: rgb(34, 197, 94);
	}
	.progress-amber {
		background: rgb(234, 179, 8);
	}
	.progress-red {
		background: rgb(220, 38, 38);
	}

	.card {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.card-header {
		padding: var(--spacing-4) var(--spacing-4) 0;
	}

	.card-header h3 {
		margin: 0 0 var(--spacing-1);
		font-size: var(--text-lg);
		font-weight: 600;
	}

	.card-blurb {
		margin: 0 0 var(--spacing-3);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}

	.recent-table {
		width: 100%;
		border-collapse: collapse;
	}

	.recent-table th,
	.recent-table td {
		text-align: left;
		padding: var(--spacing-3) var(--spacing-4);
		border-top: 1px solid var(--color-border);
		font-size: var(--text-sm);
		vertical-align: middle;
	}

	.recent-table th {
		background: var(--color-surface-muted);
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.short-id-link {
		font-family: var(--font-mono, monospace);
		color: var(--color-primary);
		text-decoration: none;
	}

	.short-id-link:hover {
		text-decoration: underline;
	}
</style>
