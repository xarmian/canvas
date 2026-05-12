<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();

	// Section nav is forward-compatible: when /account/storage (TASK-173)
	// and any future account pages land, they just add to this array.
	const sections: { href: string; label: string; testid: string }[] = [
		{ href: '/account/api-keys', label: 'API keys', testid: 'account-nav-api-keys' }
	];

	let pathname = $derived(page.url.pathname);
</script>

<div class="account-shell">
	<h1 class="account-title">Account</h1>
	<nav class="account-nav" aria-label="Account sections">
		{#each sections as section (section.href)}
			<a
				href={section.href}
				class="account-nav-link"
				class:active={pathname.startsWith(section.href)}
				data-testid={section.testid}
				aria-current={pathname.startsWith(section.href) ? 'page' : undefined}
			>
				{section.label}
			</a>
		{/each}
	</nav>
	<section class="account-content">
		{@render children()}
	</section>
</div>

<style>
	.account-shell {
		max-width: 64rem;
		margin: 0 auto;
		display: grid;
		gap: var(--spacing-6);
	}

	.account-title {
		font-size: var(--text-2xl);
		font-weight: 700;
		margin: 0;
	}

	.account-nav {
		display: flex;
		gap: var(--spacing-4);
		border-bottom: 1px solid var(--color-border);
		padding-bottom: var(--spacing-2);
	}

	.account-nav-link {
		text-decoration: none;
		color: var(--color-text-muted);
		font-weight: 500;
		padding: var(--spacing-1) var(--spacing-2);
		border-radius: var(--radius-sm);
	}

	.account-nav-link.active {
		color: var(--color-text);
		font-weight: 600;
		background: var(--color-surface-muted);
	}

	.account-nav-link:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.account-content {
		display: grid;
		gap: var(--spacing-6);
	}
</style>
