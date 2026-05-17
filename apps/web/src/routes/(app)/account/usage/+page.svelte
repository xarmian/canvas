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

	/** Tailwind-ish source palette — kept inline because chart.js draws
	 *  to a `<canvas>` and can't read CSS variables. Colors are chosen
	 *  for ~equal perceptual weight on the page background and remain
	 *  legible in dark mode (the editor is light-theme-only today). */
	const SOURCE_COLORS: Record<string, string> = {
		'on-the-fly': '#3b82f6', // blue-500
		'baked-api': '#10b981', // emerald-500
		'baked-app': '#8b5cf6', // violet-500
		preview: '#f59e0b' // amber-500
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

	// Per-canvas hit breakdown isn't carried on this surface in v1 —
	// the tile-level `cacheHitRate` covers the user-scoped average,
	// and the editor's per-canvas page (TASK-196) is the right surface
	// for canvas-scoped hit rate. Pulling miss% into this table would
	// require an extra query that v1 doesn't need.
	const cacheHitDisplay = $derived(formatHitRate(data.usage.cacheHitRate));
	const totalDisplay = $derived(data.usage.total.toLocaleString());
	const mostActiveCanvas = $derived(data.usage.topCanvases[0] ?? null);
	const mostActiveApiKey = $derived(data.usage.topApiKeys[0] ?? null);
</script>

<svelte:head>
	<title>Usage · Canvas</title>
</svelte:head>

<div class="page-header">
	<h2 class="section-title">Render usage (30d)</h2>
	<p class="section-blurb">
		Activity from every render path — public page renders, baked POSTs, and editor previews — over
		the last 30 days. The chart updates as renders happen; counts are eventually consistent within a
		few seconds.
	</p>
</div>

<div class="stat-grid" data-testid="usage-stats">
	<div class="stat">
		<div class="stat-label">Renders (30d)</div>
		<div class="stat-value" data-testid="stat-total">{totalDisplay}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Cache hit rate (30d)</div>
		<div class="stat-value" data-testid="stat-hit-rate">{cacheHitDisplay}</div>
	</div>
	<div class="stat">
		<div class="stat-label">Most active canvas</div>
		<div class="stat-value stat-value-sm" data-testid="stat-top-canvas">
			{#if mostActiveCanvas}
				<a class="stat-link" href="/canvas/{mostActiveCanvas.canvasId}/edit">
					{mostActiveCanvas.canvasName ?? '—'}
				</a>
			{:else}
				—
			{/if}
		</div>
	</div>
	<div class="stat">
		<div class="stat-label">Most active API key</div>
		<div class="stat-value stat-value-sm" data-testid="stat-top-api-key">
			{#if mostActiveApiKey}
				<a class="stat-link" href="/account/api-keys">
					{mostActiveApiKey.apiKeyName ?? '—'}
				</a>
			{:else}
				—
			{/if}
		</div>
	</div>
</div>

<div class="card">
	<header class="card-header">
		<h3>Renders per day</h3>
		<p class="card-blurb">
			Stacked by source so you can see which path drove the traffic on any given day.
		</p>
	</header>
	<div class="chart-wrap" data-testid="usage-chart">
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
		<p class="card-blurb">Most-rendered canvases in the last 30 days.</p>
	</header>
	{#if data.usage.topCanvases.length === 0}
		<EmptyState
			icon={Activity}
			title="No activity yet"
			description="Render a canvas and it'll show up here. Public renders, baked POSTs, and editor previews all count."
		/>
	{:else}
		<table class="usage-table" data-testid="top-canvases">
			<thead>
				<tr>
					<th scope="col">Canvas</th>
					<th scope="col" class="num">Renders</th>
				</tr>
			</thead>
			<tbody>
				{#each data.usage.topCanvases as canvas (canvas.canvasId)}
					<tr>
						<td>
							<a href="/canvas/{canvas.canvasId}/edit" class="row-link">
								{canvas.canvasName ?? '—'}
							</a>
						</td>
						<td class="num">{canvas.total.toLocaleString()}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<div class="card">
	<header class="card-header">
		<h3>Top API keys</h3>
		<p class="card-blurb">Which keys drove the most requests in the last 30 days.</p>
	</header>
	{#if data.usage.topApiKeys.length === 0}
		<EmptyState
			icon={Activity}
			title="No API-key activity yet"
			description="Once a bearer-authenticated request lands at /api/v1/renders, the API key shows up here."
		/>
	{:else}
		<table class="usage-table" data-testid="top-api-keys">
			<thead>
				<tr>
					<th scope="col">API key</th>
					<th scope="col" class="num">Requests</th>
					<th scope="col"></th>
				</tr>
			</thead>
			<tbody>
				{#each data.usage.topApiKeys as key (key.apiKeyId)}
					<tr>
						<td>{key.apiKeyName ?? '—'}</td>
						<td class="num">{key.total.toLocaleString()}</td>
						<td>
							<a href="/account/api-keys" class="row-link">Manage →</a>
						</td>
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
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
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

	.stat-value-sm {
		font-size: var(--text-lg);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stat-link {
		color: var(--color-primary);
		text-decoration: none;
	}

	.stat-link:hover {
		text-decoration: underline;
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
</style>
