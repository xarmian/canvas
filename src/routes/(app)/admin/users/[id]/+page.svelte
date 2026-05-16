<script lang="ts">
	import { Button, ConfirmDialog, Input, Modal } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	type ApiKey = (typeof data.apiKeys)[number];

	// Revoke-API-key flow state. Single-confirm ConfirmDialog (less
	// destructive than the typed-confirm force-delete). `pendingRevoke`
	// holds the row we'd act on; `revokeInFlight` blocks double-submit.
	let pendingRevoke = $state<ApiKey | null>(null);
	let revokeInFlight = $state(false);

	async function revokeApiKey() {
		if (!pendingRevoke || revokeInFlight) return;
		revokeInFlight = true;
		try {
			const res = await fetch(
				`/api/admin/users/${data.targetUser.id}/api-keys/${pendingRevoke.id}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				toast.error(body?.message ?? `Could not revoke key (HTTP ${res.status})`);
				return;
			}
			toast.success(`Revoked key "${pendingRevoke.name}"`);
			pendingRevoke = null;
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Network error');
		} finally {
			revokeInFlight = false;
		}
	}

	function cancelRevoke() {
		if (revokeInFlight) return;
		pendingRevoke = null;
	}

	// Force-delete flow state. Typed-confirmation modal (CONVE-41:
	// always use styled components, never window.confirm). `inFlight`
	// blocks dismissal + re-submission while the POST is running.
	let forceDeleteOpen = $state(false);
	let typedConfirm = $state('');
	let forceDeleteInFlight = $state(false);

	const typedMatches = $derived(
		typedConfirm.trim().toLowerCase() === data.targetUser.email.toLowerCase()
	);

	async function forceDeleteAllRenders() {
		if (forceDeleteInFlight || !typedMatches) return;
		forceDeleteInFlight = true;
		try {
			const res = await fetch(`/api/admin/users/${data.targetUser.id}/force-delete-renders`, {
				method: 'POST'
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				toast.error(body?.message ?? `Could not delete renders (HTTP ${res.status})`);
				return;
			}
			const { deleted } = (await res.json()) as { deleted: number };
			toast.success(
				`Deleted ${deleted} render${deleted === 1 ? '' : 's'} for ${data.targetUser.email}`
			);
			forceDeleteOpen = false;
			typedConfirm = '';
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Network error');
		} finally {
			forceDeleteInFlight = false;
		}
	}

	function closeForceDelete() {
		if (forceDeleteInFlight) return;
		forceDeleteOpen = false;
		typedConfirm = '';
	}

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

<!-- Recently-used renders table -->
<div class="card" data-testid="user-recent-renders">
	<header class="card-header">
		<h3>Recently used</h3>
		<p class="card-blurb">Last 10 renders sorted by access time.</p>
	</header>
	{#if data.recentRenders.length === 0}
		<div class="card-body muted empty">No renders for this user.</div>
	{:else}
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
				{#each data.recentRenders as row (row.shortId)}
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
	{/if}
</div>

<!-- API keys -->
<div class="card" data-testid="user-api-keys">
	<header class="card-header">
		<h3>API keys</h3>
		<p class="card-blurb">
			Active + revoked keys for this user. Revoke is server-side admin-gated and audit-logged.
		</p>
	</header>
	{#if data.apiKeys.length === 0}
		<div class="card-body muted empty">No API keys for this user.</div>
	{:else}
		<table class="keys-table" data-testid="api-keys-table">
			<thead>
				<tr>
					<th scope="col">Name</th>
					<th scope="col">Prefix</th>
					<th scope="col">Scopes</th>
					<th scope="col">Created</th>
					<th scope="col">Last used</th>
					<th scope="col" class="num">Requests (30d)</th>
					<th scope="col">Last 429</th>
					<th scope="col">Status</th>
					<th scope="col" class="actions-col">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.apiKeys as key (key.id)}
					{@const revoked = key.revokedAt !== null}
					<tr class:revoked>
						<td>{key.name}</td>
						<td><code class="mono">{key.prefix}</code></td>
						<td class="scopes-cell">
							{#if key.scopes.length === 0}
								<span class="muted">—</span>
							{:else}
								{key.scopes.join(', ')}
							{/if}
						</td>
						<td>{formatRelative(key.createdAt)}</td>
						<td>{formatRelative(key.lastUsedAt)}</td>
						<!--
							Per-key 30-day counters mirroring /account/api-keys
							(TASK-199 mirrors TASK-197). Same batched helper, so
							the admin and the user see identical numbers for the
							same key. Revoked keys keep their history.
						-->
						<td class="num" data-testid="key-request-count">
							{key.requestCount.toLocaleString()}
						</td>
						<td data-testid="key-last-429">{formatRelative(key.last429At)}</td>
						<td>
							{#if revoked}
								<span class="badge badge-revoked">
									Revoked {formatRelative(key.revokedAt)}
								</span>
							{:else}
								<span class="badge badge-active">Active</span>
							{/if}
						</td>
						<td class="actions-col">
							{#if !revoked}
								<Button
									variant="danger"
									size="sm"
									disabled={revokeInFlight && pendingRevoke?.id === key.id}
									onclick={() => (pendingRevoke = key)}
									data-testid="revoke-key-button-{key.id}"
								>
									Revoke
								</Button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<ConfirmDialog
	open={pendingRevoke !== null}
	title="Revoke API key"
	message={pendingRevoke
		? `Revoke "${pendingRevoke.name}" (${pendingRevoke.prefix}) for ${data.targetUser.email}? Bearer requests using this key will start failing immediately. Revocation is soft — the key row stays in the table for audit.`
		: ''}
	confirmLabel={revokeInFlight ? 'Revoking…' : 'Revoke'}
	cancelLabel="Cancel"
	variant="danger"
	onConfirm={revokeApiKey}
	onCancel={cancelRevoke}
/>

<!-- Danger zone — force-delete all renders for this user. -->
<div class="card danger-zone" data-testid="user-danger-zone">
	<header class="card-header">
		<h3>Danger zone</h3>
		<p class="card-blurb">
			Irreversible operations on this user's data. Server-side admin check, audit-logged.
		</p>
	</header>
	<div class="danger-row">
		<div>
			<strong>Delete all renders</strong>
			<p class="danger-blurb">
				Soft-deletes every live render owned by this user.
				<code>/i/&lt;shortId&gt;</code> URLs stop working immediately.
			</p>
		</div>
		<Button
			variant="danger"
			disabled={data.storageStats.renderCount === 0}
			onclick={() => (forceDeleteOpen = true)}
			data-testid="force-delete-renders-button"
		>
			Delete all {data.storageStats.renderCount} render{data.storageStats.renderCount === 1
				? ''
				: 's'}
		</Button>
	</div>
</div>

<Modal
	open={forceDeleteOpen}
	title="Force-delete all renders"
	dismissible={!forceDeleteInFlight}
	onClose={closeForceDelete}
>
	<p class="modal-message">
		This will soft-delete <strong>{data.storageStats.renderCount}</strong>
		render{data.storageStats.renderCount === 1 ? '' : 's'} for
		<code>{data.targetUser.email}</code>. URLs at <code>/i/&lt;shortId&gt;</code> stop working immediately;
		blob storage is freed by the sweep job.
	</p>
	<label class="confirm-label">
		Type the user's email <code>{data.targetUser.email}</code> to confirm:
		<Input
			type="email"
			bind:value={typedConfirm}
			placeholder={data.targetUser.email}
			autocomplete="off"
			spellcheck="false"
			disabled={forceDeleteInFlight}
			data-testid="force-delete-typed-confirm"
		/>
	</label>
	{#snippet footer()}
		<Button variant="secondary" onclick={closeForceDelete} disabled={forceDeleteInFlight}>
			Cancel
		</Button>
		<Button
			variant="danger"
			disabled={!typedMatches || forceDeleteInFlight}
			onclick={forceDeleteAllRenders}
			data-testid="force-delete-confirm-button"
		>
			{forceDeleteInFlight ? 'Deleting…' : 'Delete all renders'}
		</Button>
	{/snippet}
</Modal>

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

	.danger-zone {
		border-color: rgb(220, 38, 38, 0.4);
	}

	.danger-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--spacing-4);
		padding: var(--spacing-4);
		border-top: 1px solid var(--color-border);
	}

	.danger-row > div {
		display: grid;
		gap: var(--spacing-1);
	}

	.danger-blurb {
		margin: 0;
		color: var(--color-text-muted);
		font-size: var(--text-sm);
		max-width: 36rem;
	}

	.modal-message {
		margin: 0 0 var(--spacing-3);
		line-height: 1.5;
	}

	.confirm-label {
		display: grid;
		gap: var(--spacing-2);
		font-size: var(--text-sm);
	}

	.keys-table {
		width: 100%;
		border-collapse: collapse;
	}

	.keys-table th,
	.keys-table td {
		text-align: left;
		padding: var(--spacing-3) var(--spacing-4);
		border-top: 1px solid var(--color-border);
		font-size: var(--text-sm);
		vertical-align: middle;
	}

	.keys-table th {
		background: var(--color-surface-muted);
		font-weight: 600;
		color: var(--color-text-muted);
	}

	/* TASK-199: Requests (30d) column — right-align + tabular-nums so
	   digits line up across rows, matching the /account/api-keys
	   variant from TASK-197. */
	.keys-table .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.keys-table tr.revoked td {
		color: var(--color-text-muted);
	}

	.scopes-cell {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-xs);
	}

	.actions-col {
		text-align: right;
		white-space: nowrap;
	}

	.badge {
		display: inline-block;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		font-size: var(--text-xs);
		font-weight: 600;
	}

	.badge-active {
		background: rgba(34, 197, 94, 0.15);
		color: rgb(21, 128, 61);
	}

	.badge-revoked {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}
</style>
