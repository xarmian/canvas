<script lang="ts">
	import { page } from '$app/state';
	import { AlertTriangle, FileQuestion, Home, RefreshCw } from '@lucide/svelte';

	// 404 vs 500-class get distinct copy because they call for distinct
	// next steps. We treat anything in the 5xx range as "server error"
	// regardless of exact code; SvelteKit only differentiates further
	// when an integrator wants to (we don't here).
	let status = $derived(page.status);
	let isNotFound = $derived(status === 404);
	let isServerError = $derived(status >= 500);

	let title = $derived(
		isNotFound ? 'Page not found' : isServerError ? 'Something went wrong' : 'Error'
	);
	let lede = $derived(
		isNotFound
			? "The page you were looking for isn't here. It may have been moved, deleted, or the URL was mistyped."
			: isServerError
				? 'We hit an error processing your request. The team has been notified, but you can try again — most server errors are transient.'
				: (page.error?.message ?? 'An unexpected error occurred.')
	);

	function reload() {
		// window.location.reload() is the closest equivalent to "retry" on
		// a SvelteKit error page — invalidating + reloading the route
		// would only work if the failure was in a load fn, and we don't
		// know that here. The user-facing intent is the same either way.
		window.location.reload();
	}
</script>

<svelte:head>
	<title>{title} | Canvas</title>
</svelte:head>

<div class="error-page">
	<div class="error-card">
		<div class="error-icon" aria-hidden="true">
			{#if isNotFound}
				<FileQuestion size={48} strokeWidth={1.5} />
			{:else}
				<AlertTriangle size={48} strokeWidth={1.5} />
			{/if}
		</div>

		<p class="error-status">{status}</p>
		<h1 class="error-title">{title}</h1>
		<p class="error-lede">{lede}</p>

		<div class="error-actions">
			<a href="/" class="btn btn-primary">
				<Home size={14} aria-hidden="true" />
				<span>Back to dashboard</span>
			</a>
			{#if isServerError}
				<button type="button" class="btn btn-secondary" onclick={reload}>
					<RefreshCw size={14} aria-hidden="true" />
					<span>Try again</span>
				</button>
			{/if}
		</div>

		{#if isServerError}
			<p class="error-footer">
				If this keeps happening,
				<a
					href="https://github.com/xarmian/canvas/issues/new"
					target="_blank"
					rel="noopener noreferrer">file an issue on GitHub</a
				>.
			</p>
		{/if}
	</div>
</div>

<style>
	.error-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		background: #f8fafc;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
	}

	.error-card {
		max-width: 32rem;
		text-align: center;
		background: #fff;
		border: 1px solid #e2e8f0;
		border-radius: 12px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.04);
		padding: 2.5rem 2rem 2rem;
	}

	.error-icon {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		color: #2563eb;
		margin-bottom: 1rem;
	}

	.error-status {
		margin: 0 0 0.5rem;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 1px;
		color: #94a3b8;
		text-transform: uppercase;
	}

	.error-title {
		margin: 0 0 0.75rem;
		font-size: 1.5rem;
		font-weight: 700;
		color: #0f172a;
	}

	.error-lede {
		margin: 0 0 1.75rem;
		font-size: 0.95rem;
		line-height: 1.6;
		color: #475569;
	}

	.error-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
		flex-wrap: wrap;
		margin-bottom: 1.25rem;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.55rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		text-decoration: none;
		border: 1px solid transparent;
		cursor: pointer;
	}

	.btn-primary {
		background: #2563eb;
		color: #fff;
	}

	.btn-primary:hover {
		background: #1d4ed8;
	}

	.btn-secondary {
		background: #fff;
		color: #374151;
		border-color: #d1d5db;
	}

	.btn-secondary:hover {
		background: #f3f4f6;
	}

	.error-footer {
		margin: 0;
		font-size: 0.8125rem;
		color: #94a3b8;
		line-height: 1.5;
	}

	.error-footer a {
		color: #2563eb;
	}

	.error-footer a:hover {
		text-decoration: underline;
	}
</style>
