<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Button, Modal, ConfirmDialog, Input, EmptyState } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { Copy, KeyRound } from '@lucide/svelte';

	let { data } = $props();

	type KeyRow = {
		id: string;
		name: string;
		prefix: string;
		scopes: string[];
		lastUsedAt: string | Date | null;
		revokedAt: string | Date | null;
		createdAt: string | Date;
		// Per-key 30-day usage (TASK-197). `requestCount` is a row count
		// from `render_events`; `last429At` is the most recent throttled
		// request. Both come from the batched server load — never null,
		// always a number / ISO-or-null.
		requestCount: number;
		last429At: string | null;
		lastErrorAt: string | null;
	};

	// Create-flow state
	let showCreateModal = $state(false);
	let createName = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);
	// One-time token result. The full plaintext is held in component state
	// while the success modal is open; we clear it on close so it never
	// lingers in memory across navigations.
	let createdToken = $state<{ token: string; prefix: string; name: string } | null>(null);

	// Revoke-flow state
	let revokeTarget = $state<KeyRow | null>(null);
	let revoking = $state(false);

	function openCreateModal() {
		createName = '';
		createError = null;
		showCreateModal = true;
	}

	function closeCreateModal() {
		if (creating) return;
		showCreateModal = false;
	}

	function closeCreatedTokenModal() {
		// Drop the plaintext from JS memory. The user has already been told
		// (loudly) that this is the only time it's shown.
		createdToken = null;
	}

	async function submitCreate(event: SubmitEvent) {
		event.preventDefault();
		if (creating) return;
		const name = createName.trim();
		if (!name) {
			createError = 'Give the key a name so you can recognize it later.';
			return;
		}
		creating = true;
		createError = null;
		try {
			const res = await fetch('/api/account/api-keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				createError = body?.message ?? `Could not create key (HTTP ${res.status})`;
				return;
			}
			const payload = await res.json();
			showCreateModal = false;
			createdToken = { token: payload.token, prefix: payload.prefix, name: payload.name };
			await invalidateAll();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Network error';
		} finally {
			creating = false;
		}
	}

	function askRevoke(row: KeyRow) {
		revokeTarget = row;
	}

	async function confirmRevoke() {
		if (!revokeTarget || revoking) return;
		revoking = true;
		const target = revokeTarget;
		try {
			const res = await fetch(`/api/account/api-keys/${target.id}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 204) {
				const body = await res.json().catch(() => ({}));
				toast.error(body?.message ?? `Could not revoke (HTTP ${res.status})`);
				return;
			}
			toast.success(`API key "${target.name}" revoked`);
			revokeTarget = null;
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Network error');
		} finally {
			revoking = false;
		}
	}

	async function copyToken(token: string) {
		try {
			await navigator.clipboard.writeText(token);
			toast.success('Token copied to clipboard');
		} catch {
			// Clipboard API can fail in non-secure contexts or with a denied
			// permission. Fall back to a select-all selection so the user
			// can copy manually — the token is still visible in the code
			// block.
			toast.error('Could not copy automatically — select the text and copy with Ctrl/Cmd+C.');
		}
	}

	function formatDate(value: string | Date | null): string {
		if (!value) return 'Never';
		const date = typeof value === 'string' ? new Date(value) : value;
		return date.toLocaleString();
	}

	/** Coarse "Xh ago / Yd ago" formatter for the Last 429 column. Same
	 *  rounding ladder as `/account/storage` (TASK-173) so the two
	 *  surfaces feel consistent. Returns `'—'` for never-throttled keys
	 *  so the column reads cleanly without a `null`-vs-`undefined` UX
	 *  bug. */
	function formatRelative(value: string | null): string {
		if (!value) return '—';
		const diffMs = Date.now() - new Date(value).getTime();
		if (diffMs < 60_000) return 'just now';
		const min = Math.floor(diffMs / 60_000);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const day = Math.floor(hr / 24);
		if (day < 30) return `${day}d ago`;
		const mo = Math.floor(day / 30);
		return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
	}
</script>

<svelte:head>
	<title>API keys · Canvas</title>
</svelte:head>

<div class="page-header">
	<div>
		<h2 class="section-title">API keys</h2>
		<p class="section-blurb">
			Authenticate your backend to the Canvas Render API. Treat keys like passwords — anyone holding
			one can render images, list them, and delete them on your behalf.
		</p>
	</div>
	<Button variant="primary" onclick={openCreateModal} data-testid="create-api-key">
		Create API key
	</Button>
</div>

{#if data.keys.length === 0}
	<EmptyState
		icon={KeyRound}
		title="No API keys yet"
		description="Create one to start using the render API from your own services."
	>
		{#snippet cta()}
			<Button variant="primary" onclick={openCreateModal} data-testid="create-api-key-empty">
				Create API key
			</Button>
		{/snippet}
	</EmptyState>
{:else}
	<div class="table-wrap">
		<table class="key-table" data-testid="api-keys-table">
			<thead>
				<tr>
					<th scope="col">Name</th>
					<th scope="col">Prefix</th>
					<th scope="col">Created</th>
					<th scope="col">Last used</th>
					<th scope="col" class="num">Requests (30d)</th>
					<th scope="col">Last 429</th>
					<th scope="col">Status</th>
					<th scope="col"><span class="sr-only">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.keys as row (row.id)}
					<tr data-testid="api-key-row" data-key-id={row.id}>
						<td>{row.name}</td>
						<td><code class="prefix">{row.prefix}…</code></td>
						<td>{formatDate(row.createdAt)}</td>
						<td>{formatDate(row.lastUsedAt)}</td>
						<!--
							Per-key 30-day counters (TASK-197). Revoked keys keep
							their history — events don't care about revokedAt —
							so the columns render the same way whether the key
							is active or revoked. `requestCount` is always a
							number (zero for never-used); `last429At` may be
							null, formatted as '—'.
						-->
						<td class="num" data-testid="key-request-count">
							{row.requestCount.toLocaleString()}
						</td>
						<td data-testid="key-last-429">{formatRelative(row.last429At)}</td>
						<td>
							{#if row.revokedAt}
								<span class="badge badge-revoked" data-testid="status-revoked">Revoked</span>
							{:else}
								<span class="badge badge-active" data-testid="status-active">Active</span>
							{/if}
						</td>
						<td class="row-actions">
							{#if !row.revokedAt}
								<Button
									variant="secondary"
									size="sm"
									onclick={() => askRevoke(row)}
									data-testid="revoke-api-key"
								>
									Revoke
								</Button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<!-- Name-the-key modal -->
<Modal
	open={showCreateModal}
	title="Create API key"
	width="28rem"
	onClose={closeCreateModal}
	initialFocus="#new-api-key-name"
>
	<form onsubmit={submitCreate}>
		<label class="form-label" for="new-api-key-name">Name</label>
		<Input
			id="new-api-key-name"
			value={createName}
			oninput={(e) => (createName = (e.currentTarget as HTMLInputElement).value)}
			placeholder="e.g. Production server"
			maxlength={80}
			invalid={createError !== null}
			errorMessage={createError ?? undefined}
			data-testid="create-api-key-name"
			autocomplete="off"
		/>
		<p class="form-help">
			You'll see the full key once, right after creation. Save it somewhere safe.
		</p>
		<!-- The Modal's <dialog> traps Enter on the form — we still need a real
		     submit button to fire it consistently across browsers. -->
		<button type="submit" hidden aria-hidden="true" tabindex="-1"></button>
	</form>
	{#snippet footer()}
		<Button variant="secondary" onclick={closeCreateModal} disabled={creating}>Cancel</Button>
		<Button
			variant="primary"
			onclick={() => submitCreate(new SubmitEvent('submit'))}
			disabled={creating}
			data-testid="create-api-key-submit"
		>
			{creating ? 'Creating…' : 'Create key'}
		</Button>
	{/snippet}
</Modal>

<!-- Copy-once success modal. Dismissible only via the explicit
     "I've saved it" CTA — `dismissible={false}` blocks Escape and
     backdrop-click so the user can't half-close it and lose the token. -->
<Modal
	open={createdToken !== null}
	title="Save your API key now"
	width="36rem"
	dismissible={false}
	onClose={closeCreatedTokenModal}
	initialFocus="[data-testid='copy-new-token']"
>
	{#if createdToken}
		<p class="form-blurb">
			This is the only time the full key for <strong>{createdToken.name}</strong> will be shown.
			After you close this dialog the value cannot be retrieved — only the prefix
			<code>{createdToken.prefix}</code> remains in the dashboard.
		</p>
		<div class="token-box">
			<code class="token-value" data-testid="new-token-value">{createdToken.token}</code>
			<Button
				variant="secondary"
				size="sm"
				onclick={() => copyToken(createdToken!.token)}
				data-testid="copy-new-token"
			>
				<Copy size={14} />
				Copy
			</Button>
		</div>
	{/if}
	{#snippet footer()}
		<Button variant="primary" onclick={closeCreatedTokenModal} data-testid="acknowledge-new-token">
			I've saved it
		</Button>
	{/snippet}
</Modal>

<ConfirmDialog
	open={revokeTarget !== null}
	title="Revoke API key"
	message={revokeTarget
		? `Revoke "${revokeTarget.name}"? Any service using this key will stop working immediately. This cannot be undone.`
		: ''}
	confirmLabel={revoking ? 'Revoking…' : 'Revoke'}
	cancelLabel="Cancel"
	variant="danger"
	onConfirm={confirmRevoke}
	onCancel={() => {
		if (!revoking) revokeTarget = null;
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
		max-width: 40rem;
		line-height: 1.4;
	}

	.table-wrap {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.key-table {
		width: 100%;
		border-collapse: collapse;
	}

	.key-table th,
	.key-table td {
		text-align: left;
		padding: var(--spacing-3) var(--spacing-4);
		border-bottom: 1px solid var(--color-border);
		vertical-align: middle;
	}

	.key-table tbody tr:last-child td {
		border-bottom: none;
	}

	.key-table th {
		background: var(--color-surface-muted);
		font-weight: 600;
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	/* TASK-197: Requests (30d) column is a count — right-align + tabular
	   nums so digits line up cleanly across rows. */
	.key-table .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.prefix {
		font-family: var(--font-mono, monospace);
		background: var(--color-surface-muted);
		padding: 0 var(--spacing-2);
		border-radius: var(--radius-sm);
	}

	.badge {
		display: inline-block;
		padding: var(--spacing-1) var(--spacing-2);
		border-radius: var(--radius-sm);
		font-size: var(--text-sm);
		font-weight: 500;
	}

	.badge-active {
		background: rgba(34, 197, 94, 0.12);
		color: rgb(21, 128, 61);
	}

	.badge-revoked {
		background: rgba(220, 38, 38, 0.12);
		color: rgb(153, 27, 27);
	}

	.row-actions {
		text-align: right;
	}

	.form-label {
		display: block;
		font-weight: 600;
		font-size: var(--text-sm);
		margin-bottom: var(--spacing-1);
	}

	.form-help {
		margin: var(--spacing-2) 0 0;
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}

	.form-blurb {
		margin: 0 0 var(--spacing-4);
		color: var(--color-text);
		line-height: 1.5;
	}

	.token-box {
		display: flex;
		align-items: center;
		gap: var(--spacing-2);
		padding: var(--spacing-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-muted);
	}

	.token-value {
		flex: 1;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-sm);
		word-break: break-all;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
