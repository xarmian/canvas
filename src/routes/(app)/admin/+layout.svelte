<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();

	// Forward-compatible nav: more admin sections will land here as
	// /admin/users etc. ship.
	const sections: { href: string; label: string; testid: string }[] = [
		{ href: '/admin/storage', label: 'Storage', testid: 'admin-nav-storage' }
	];

	let pathname = $derived(page.url.pathname);
</script>

<div class="admin-shell">
	<h1 class="admin-title">Admin</h1>
	<nav class="admin-nav" aria-label="Admin sections">
		{#each sections as section (section.href)}
			<a
				href={section.href}
				class="admin-nav-link"
				class:active={pathname.startsWith(section.href)}
				data-testid={section.testid}
				aria-current={pathname.startsWith(section.href) ? 'page' : undefined}
			>
				{section.label}
			</a>
		{/each}
	</nav>
	<section class="admin-content">
		{@render children()}
	</section>
</div>

<style>
	.admin-shell {
		max-width: 72rem;
		margin: 0 auto;
		display: grid;
		gap: var(--spacing-6);
	}

	.admin-title {
		font-size: var(--text-2xl);
		font-weight: 700;
		margin: 0;
	}

	.admin-nav {
		display: flex;
		gap: var(--spacing-4);
		border-bottom: 1px solid var(--color-border);
		padding-bottom: var(--spacing-2);
	}

	.admin-nav-link {
		text-decoration: none;
		color: var(--color-text-muted);
		font-weight: 500;
		padding: var(--spacing-1) var(--spacing-2);
		border-radius: var(--radius-sm);
	}

	.admin-nav-link.active {
		color: var(--color-text);
		font-weight: 600;
		background: var(--color-surface-muted);
	}

	.admin-nav-link:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.admin-content {
		display: grid;
		gap: var(--spacing-6);
	}
</style>
