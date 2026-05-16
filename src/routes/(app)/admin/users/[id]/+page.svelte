<script lang="ts">
	let { data } = $props();

	// formatBytes + formatRelative are the same helpers /account/storage
	// and /admin/storage inline. Extracting them into a shared module is
	// the obvious next refactor (three callers now); leaving it for a
	// dedicated follow-up so this PR stays scoped to the tiles task.
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

	const dateFormatter = new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});

	function formatDateTime(value: string | null): string {
		if (!value) return '—';
		return dateFormatter.format(new Date(value));
	}
</script>

<svelte:head>
	<title>{data.targetUser.email} · User admin · Canvas</title>
</svelte:head>

<div class="page-header">
	<div>
		<h2 class="section-title">User admin</h2>
		<p class="section-blurb">
			Per-user drilldown — mirrors the shape of <a href="/account/storage">/account/storage</a> scoped
			to this user.
		</p>
	</div>
	<a class="back-link" href="/admin/storage" data-testid="back-to-storage">← Storage admin</a>
</div>

<!-- Identity card -->
<div class="card" data-testid="user-identity-card">
	<header class="card-header">
		<h3>{data.targetUser.email}</h3>
		<p class="card-blurb">
			User <code>{data.targetUser.id}</code>
		</p>
	</header>
	<dl class="identity-list">
		<div class="identity-row">
			<dt>Email</dt>
			<dd data-testid="identity-email">
				<code class="mono">{data.targetUser.email}</code>
			</dd>
		</div>
		<div class="identity-row">
			<dt>Created</dt>
			<dd data-testid="identity-created-at">
				<time datetime={data.targetUser.createdAt}>
					{formatDateTime(data.targetUser.createdAt)}
					<span class="muted">({formatRelative(data.targetUser.createdAt)})</span>
				</time>
			</dd>
		</div>
		<div class="identity-row">
			<dt>Last sign-in</dt>
			<dd data-testid="identity-last-sign-in">
				{#if data.targetUser.lastSignInAt}
					<time datetime={data.targetUser.lastSignInAt}>
						{formatDateTime(data.targetUser.lastSignInAt)}
						<span class="muted">({formatRelative(data.targetUser.lastSignInAt)})</span>
					</time>
				{:else}
					<span class="muted">Never</span>
				{/if}
			</dd>
		</div>
	</dl>
</div>

<!-- Stat tiles -->
<div class="stat-grid" data-testid="user-storage-stats">
	<div class="stat">
		<div class="stat-label">Renders</div>
		<div class="stat-value" data-testid="stat-render-count">{data.storageStats.renderCount}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Total storage</div>
		<div class="stat-value" data-testid="stat-total-bytes">
			{formatBytes(data.storageStats.totalBytes)}
		</div>
	</div>
	<div class="stat">
		<div class="stat-label">Oldest render</div>
		<div class="stat-value" data-testid="stat-oldest">
			{formatRelative(data.storageStats.oldestCreatedAt)}
		</div>
	</div>
	<div class="stat">
		<div class="stat-label">Most recently used</div>
		<div class="stat-value" data-testid="stat-most-recent">
			{formatRelative(data.storageStats.mostRecentAccessAt)}
		</div>
	</div>
</div>

<!-- Recently-used renders table — TASK-184 hydrates. -->
<div class="card" data-testid="user-recent-renders">
	<header class="card-header">
		<h3>Recently-used renders</h3>
		<p class="card-blurb">10 most recent — populated in a follow-up.</p>
	</header>
	<div class="card-body muted empty">No data yet.</div>
</div>

<!-- API keys — TASK-187 hydrates. -->
<div class="card" data-testid="user-api-keys">
	<header class="card-header">
		<h3>API keys</h3>
		<p class="card-blurb">Read-only list — populated in a follow-up.</p>
	</header>
	<div class="card-body muted empty">No data yet.</div>
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

	.back-link {
		color: var(--color-primary);
		text-decoration: none;
		font-weight: 500;
		font-size: var(--text-sm);
		white-space: nowrap;
	}

	.back-link:hover {
		text-decoration: underline;
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

	.card-body {
		padding: var(--spacing-3) var(--spacing-4) var(--spacing-4);
		border-top: 1px solid var(--color-border);
		font-size: var(--text-sm);
	}

	.empty {
		text-align: center;
		padding: var(--spacing-6) var(--spacing-4);
	}

	.muted {
		color: var(--color-text-muted);
	}

	.identity-list {
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--color-border);
	}

	.identity-row {
		display: grid;
		grid-template-columns: minmax(8rem, 12rem) 1fr;
		gap: var(--spacing-4);
		padding: var(--spacing-3) var(--spacing-4);
		font-size: var(--text-sm);
		align-items: baseline;
	}

	.identity-row + .identity-row {
		border-top: 1px solid var(--color-border);
	}

	.identity-row dt {
		color: var(--color-text-muted);
		font-weight: 500;
	}

	.identity-row dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}

	.mono {
		font-family: var(--font-mono, monospace);
	}
</style>
