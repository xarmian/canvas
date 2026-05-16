<script lang="ts">
	import { browser } from '$app/environment';
	import { Bar } from 'svelte-chartjs';
	import {
		Chart as ChartJS,
		CategoryScale,
		LinearScale,
		BarElement,
		Title,
		Tooltip,
		Legend
	} from 'chart.js';
	import { EmptyState } from '$lib/components/ui';
	import { Activity } from '@lucide/svelte';

	// chart.js requires explicit element registration. Calling
	// `register` on every page mount is a no-op past the first call
	// because chart.js dedupes internally — safe to do at module
	// scope alongside the import.
	ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

	let { data } = $props();

	/** Tailwind-ish source palette — mirrors `/account/usage` so the two
	 *  surfaces feel like the same chart. chart.js paints to `<canvas>`
	 *  and can't read CSS variables, so colors are inline. */
	const SOURCE_COLORS: Record<string, string> = {
		'on-the-fly': '#3b82f6',
		'baked-api': '#10b981',
		'baked-app': '#8b5cf6',
		preview: '#f59e0b'
	};
	const SOURCE_LABELS: Record<string, string> = {
		'on-the-fly': 'On-the-fly',
		'baked-api': 'Baked (API)',
		'baked-app': 'Baked (App)',
		preview: 'Preview'
	};

	const chartData = $derived({
		labels: data.chart.labels,
		datasets: data.chart.series.map((s) => ({
			label: SOURCE_LABELS[s.source] ?? s.source,
			data: s.data,
			backgroundColor: SOURCE_COLORS[s.source] ?? '#9ca3af',
			borderColor: SOURCE_COLORS[s.source] ?? '#9ca3af',
			stack: 'renders'
		}))
	});

	const chartOptions = {
		responsive: true,
		maintainAspectRatio: false,
		plugins: {
			legend: { position: 'top' as const },
			tooltip: { mode: 'index' as const, intersect: false }
		},
		scales: {
			x: { stacked: true, ticks: { autoSkip: true, maxTicksLimit: 10 } },
			y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }
		}
	};

	function formatHitRate(rate: number | null): string {
		if (rate === null) return '—';
		return `${Math.round(rate * 100)}%`;
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
		return `${Math.floor(day / 30)}mo ago`;
	}

	function formatDuration(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${ms} ms`;
		return `${(ms / 1000).toFixed(2)} s`;
	}
</script>

<svelte:head>
	<title>Usage · Admin · Canvas</title>
</svelte:head>

<div class="page-header">
	<h2 class="section-title">Instance render usage (30d)</h2>
	<p class="section-blurb">
		Instance-wide activity across every render path. Numbers are aggregated over the last 30 days
		and update as events land.
	</p>
</div>

<div class="stat-grid" data-testid="admin-usage-stats">
	<div class="stat">
		<div class="stat-label">Total renders (30d)</div>
		<div class="stat-value" data-testid="stat-total">
			{data.usage.total.toLocaleString()}
		</div>
	</div>
	<div class="stat">
		<div class="stat-label">Cache hit rate (30d)</div>
		<div class="stat-value" data-testid="stat-hit-rate">
			{formatHitRate(data.usage.cacheHitRate)}
		</div>
	</div>
	<div class="stat">
		<div class="stat-label">Active users (30d)</div>
		<div class="stat-value" data-testid="stat-distinct-users">
			{data.tiles.distinctUsers.toLocaleString()}
		</div>
	</div>
	<div class="stat">
		<div class="stat-label">Active API keys (30d)</div>
		<div class="stat-value" data-testid="stat-distinct-api-keys">
			{data.tiles.distinctApiKeys.toLocaleString()}
		</div>
	</div>
	<div class="stat">
		<div class="stat-label">p95 duration (30d)</div>
		<div class="stat-value" data-testid="stat-p95">
			{formatDuration(data.tiles.p95DurationMs)}
		</div>
	</div>
</div>

<div class="card">
	<header class="card-header">
		<h3>Renders per day</h3>
		<p class="card-blurb">Instance-wide, stacked by source.</p>
	</header>
	<div class="chart-wrap" data-testid="admin-usage-chart">
		{#if browser}
			<Bar data={chartData} options={chartOptions} />
		{:else}
			<!-- chart.js draws to a `<canvas>`, which doesn't exist during
			     SSR. The empty placeholder keeps the layout stable; the
			     real chart hydrates client-side. -->
			<div class="chart-placeholder" aria-hidden="true"></div>
		{/if}
	</div>
</div>

<div class="card">
	<header class="card-header">
		<h3>Top canvases</h3>
		<p class="card-blurb">Most-rendered canvases across the instance.</p>
	</header>
	{#if data.topCanvases.length === 0}
		<EmptyState
			icon={Activity}
			title="No activity yet"
			description="Once events start landing, the busiest canvases will appear here with owner email + cache-hit rate."
		/>
	{:else}
		<table class="usage-table" data-testid="admin-top-canvases">
			<thead>
				<tr>
					<th scope="col">Canvas</th>
					<th scope="col">Owner</th>
					<th scope="col" class="num">Renders</th>
					<th scope="col" class="num">Hit rate</th>
				</tr>
			</thead>
			<tbody>
				{#each data.topCanvases as canvas (canvas.canvasId)}
					<tr>
						<td>{canvas.canvasName ?? '—'}</td>
						<td>{canvas.ownerEmail ?? '—'}</td>
						<td class="num">{canvas.total.toLocaleString()}</td>
						<td class="num">{formatHitRate(canvas.hitRate)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<div class="card">
	<header class="card-header">
		<h3>Top users</h3>
		<p class="card-blurb">Highest-volume canvas owners.</p>
	</header>
	{#if data.topUsers.length === 0}
		<EmptyState
			icon={Activity}
			title="No user activity yet"
			description="Users with the most rendered canvases will appear here as events accrue."
		/>
	{:else}
		<table class="usage-table" data-testid="admin-top-users">
			<thead>
				<tr>
					<th scope="col">Email</th>
					<th scope="col" class="num">Renders</th>
					<th scope="col" class="num">Hit rate</th>
					<th scope="col"></th>
				</tr>
			</thead>
			<tbody>
				{#each data.topUsers as user (user.userId)}
					<tr>
						<td>{user.email ?? '—'}</td>
						<td class="num">{user.total.toLocaleString()}</td>
						<td class="num">{formatHitRate(user.hitRate)}</td>
						<td>
							<a href="/admin/users/{user.userId}" class="row-link">Open →</a>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<div class="card">
	<header class="card-header">
		<h3>Top API keys</h3>
		<p class="card-blurb">Highest-volume bearer-authenticated callers.</p>
	</header>
	{#if data.topApiKeys.length === 0}
		<EmptyState
			icon={Activity}
			title="No API-key activity yet"
			description="Once /api/v1/renders sees bearer-authenticated traffic, the top keys will show up here."
		/>
	{:else}
		<table class="usage-table" data-testid="admin-top-api-keys">
			<thead>
				<tr>
					<th scope="col">Key</th>
					<th scope="col">Owner</th>
					<th scope="col" class="num">Requests</th>
					<th scope="col" class="num">Last 429</th>
				</tr>
			</thead>
			<tbody>
				{#each data.topApiKeys as key (key.apiKeyId)}
					<tr>
						<td>
							<span class="key-name">{key.apiKeyName ?? '—'}</span>
							{#if key.apiKeyPrefix}
								<code class="key-prefix">{key.apiKeyPrefix}</code>
							{/if}
						</td>
						<td>{key.ownerEmail ?? '—'}</td>
						<td class="num">{key.total.toLocaleString()}</td>
						<td class="num">{formatRelative(key.last429At)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.page-header {
		display: grid;
		gap: var(--spacing-1);
	}

	.section-title {
		font-size: var(--text-xl);
		font-weight: 600;
		margin: 0;
	}

	.section-blurb {
		color: var(--color-text-muted);
		margin: 0;
		max-width: 44rem;
		line-height: 1.4;
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: var(--spacing-4);
	}

	.stat {
		background: var(--color-surface-muted);
		border-radius: var(--radius-lg);
		padding: var(--spacing-4);
		display: grid;
		gap: var(--spacing-2);
		min-height: 5rem;
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

	.chart-wrap {
		/* Fixed height so the SSR placeholder + the eventual canvas
		   occupy identical space and we don't get a layout shift on
		   hydration. */
		height: 18rem;
		padding: 0 var(--spacing-4) var(--spacing-4);
	}

	.chart-placeholder {
		width: 100%;
		height: 100%;
	}

	.usage-table {
		width: 100%;
		border-collapse: collapse;
	}

	.usage-table th,
	.usage-table td {
		text-align: left;
		padding: var(--spacing-3) var(--spacing-4);
		border-top: 1px solid var(--color-border);
		font-size: var(--text-sm);
		vertical-align: middle;
	}

	.usage-table th {
		background: var(--color-surface-muted);
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.usage-table .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.row-link {
		color: var(--color-primary);
		text-decoration: none;
	}

	.row-link:hover {
		text-decoration: underline;
	}

	.key-name {
		font-weight: 500;
		margin-right: var(--spacing-2);
	}

	.key-prefix {
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		font-size: 0.8em;
	}
</style>
