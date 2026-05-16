<script lang="ts">
	let { data } = $props();

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const kib = bytes / 1024;
		if (kib < 1024) return `${kib.toFixed(1)} KB`;
		const mib = kib / 1024;
		if (mib < 1024) return `${mib.toFixed(2)} MB`;
		const gib = mib / 1024;
		if (gib < 1024) return `${gib.toFixed(2)} GB`;
		return `${(gib / 1024).toFixed(2)} TB`;
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

	const prevOffset = $derived(Math.max(0, data.offset - data.pageSize));
	const nextOffset = $derived(data.offset + data.pageSize);
</script>

<svelte:head>
	<title>Storage admin · Canvas</title>
</svelte:head>

<div class="page-header">
	<div>
		<h2 class="section-title">Storage administration</h2>
		<p class="section-blurb">
			Instance-wide aggregates plus a per-user breakdown sorted by total bytes. Click <strong
				>View →</strong
			> in any row to drill into that user's storage detail.
		</p>
	</div>
</div>

<div class="stat-grid" data-testid="admin-storage-stats">
	<div class="stat">
		<div class="stat-label">Total renders</div>
		<div class="stat-value" data-testid="totals-renders">{data.totals.totalRenders}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Total bytes</div>
		<div class="stat-value" data-testid="totals-bytes">{formatBytes(data.totals.totalBytes)}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Active users</div>
		<div class="stat-value" data-testid="totals-active-users">{data.totals.activeUsers}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Active API keys</div>
		<div class="stat-value" data-testid="totals-active-keys">{data.activeKeys}</div>
	</div>
</div>

<div class="card">
	<header class="card-header">
		<h3>Per-user storage</h3>
		<p class="card-blurb">
			Sorted by total bytes descending. Users with zero live renders are hidden. Page size is {data.pageSize}.
		</p>
	</header>
	<table class="users-table" data-testid="per-user-table">
		<thead>
			<tr>
				<th scope="col">Email</th>
				<th scope="col">Renders</th>
				<th scope="col">Total</th>
				<th scope="col">Last active</th>
				<th scope="col">Details</th>
			</tr>
		</thead>
		<tbody>
			{#each data.perUser as user (user.id)}
				<tr>
					<td><code class="email">{user.email}</code></td>
					<td>{user.renderCount}</td>
					<td>{formatBytes(user.totalBytes)}</td>
					<td>{formatRelative(user.lastActiveAt)}</td>
					<td>
						<a class="details-link" href="/admin/users/{user.id}" data-testid="user-details-link">
							View →
						</a>
					</td>
				</tr>
			{/each}
			{#if data.perUser.length === 0}
				<tr>
					<td colspan="5" class="empty">No users have rendered images yet.</td>
				</tr>
			{/if}
		</tbody>
	</table>
	<footer class="card-footer">
		{#if data.offset > 0}
			<a href={`/admin/storage?offset=${prevOffset}`} data-testid="page-prev">← Previous</a>
		{:else}
			<span class="muted" aria-disabled="true">← Previous</span>
		{/if}
		<span class="muted">
			{data.offset + 1}–{data.offset + data.perUser.length}
		</span>
		{#if data.hasMore}
			<a href={`/admin/storage?offset=${nextOffset}`} data-testid="page-next">Next →</a>
		{:else}
			<span class="muted" aria-disabled="true">Next →</span>
		{/if}
	</footer>
</div>

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
		max-width: 48rem;
		line-height: 1.4;
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
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

	.users-table {
		width: 100%;
		border-collapse: collapse;
	}

	.users-table th,
	.users-table td {
		text-align: left;
		padding: var(--spacing-3) var(--spacing-4);
		border-top: 1px solid var(--color-border);
		font-size: var(--text-sm);
		vertical-align: middle;
	}

	.users-table th {
		background: var(--color-surface-muted);
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.email {
		font-family: var(--font-mono, monospace);
	}

	.empty {
		text-align: center;
		color: var(--color-text-muted);
		padding: var(--spacing-6);
	}

	.muted {
		color: var(--color-text-muted);
	}

	.card-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--spacing-4);
		padding: var(--spacing-3) var(--spacing-4);
		border-top: 1px solid var(--color-border);
		background: var(--color-surface-muted);
		font-size: var(--text-sm);
	}

	.card-footer a {
		text-decoration: none;
		color: var(--color-primary);
		font-weight: 500;
	}

	.card-footer a:hover {
		text-decoration: underline;
	}

	.details-link {
		color: var(--color-primary);
		text-decoration: none;
		font-weight: 500;
	}

	.details-link:hover {
		text-decoration: underline;
	}
</style>
