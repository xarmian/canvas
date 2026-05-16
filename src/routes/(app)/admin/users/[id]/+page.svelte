<script lang="ts">
	let { data } = $props();
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

<!-- Identity card — TASK-182 hydrates email/created_at/last sign-in. -->
<div class="card" data-testid="user-identity-card">
	<header class="card-header">
		<h3>{data.targetUser.email}</h3>
		<p class="card-blurb">
			User <code>{data.targetUser.id}</code>
		</p>
	</header>
	<div class="card-body muted">Identity details land in a follow-up.</div>
</div>

<!-- Stat tiles — TASK-183 hydrates render count, total bytes, oldest, most recent. -->
<div class="stat-grid" data-testid="user-storage-stats">
	<div class="stat">
		<div class="stat-label">Renders</div>
		<div class="stat-value" data-testid="stat-render-count">{data.storageStats.renderCount}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Total bytes</div>
		<div class="stat-value" data-testid="stat-total-bytes">—</div>
	</div>
	<div class="stat">
		<div class="stat-label">Oldest render</div>
		<div class="stat-value" data-testid="stat-oldest">—</div>
	</div>
	<div class="stat">
		<div class="stat-label">Most recent</div>
		<div class="stat-value" data-testid="stat-most-recent">—</div>
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
</style>
