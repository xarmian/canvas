<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui';

	let { data, children } = $props();

	async function handleLogout() {
		await authClient.signOut();
		goto('/login');
	}

	// Highlight the active top-level nav link. /canvas/[id]/edit is its own
	// route group with its own chrome, so this layout doesn't render there
	// — we just need to distinguish dashboard vs assets here.
	let pathname = $derived(page.url.pathname);
</script>

<div class="app-shell">
	<header class="app-header">
		<div class="app-brand-row">
			<a href="/dashboard" class="app-brand">Canvas</a>
			<nav aria-label="Primary" class="app-nav">
				<a
					href="/dashboard"
					data-testid="nav-dashboard"
					aria-current={pathname === '/dashboard' ? 'page' : undefined}
					class="app-nav-link"
					class:active={pathname === '/dashboard'}
				>
					Dashboard
				</a>
				<a
					href="/templates"
					data-testid="nav-templates"
					aria-current={pathname.startsWith('/templates') ? 'page' : undefined}
					class="app-nav-link"
					class:active={pathname.startsWith('/templates')}
				>
					Templates
				</a>
				<a
					href="/assets"
					data-testid="nav-assets"
					aria-current={pathname.startsWith('/assets') ? 'page' : undefined}
					class="app-nav-link"
					class:active={pathname.startsWith('/assets')}
				>
					Assets
				</a>
			</nav>
		</div>
		<div class="app-user-row">
			<span class="app-user-name">{data.user?.name ?? data.user?.email}</span>
			<Button variant="secondary" size="sm" onclick={handleLogout}>Log out</Button>
		</div>
	</header>
	<main class="app-main">
		{@render children()}
	</main>
</div>

<style>
	.app-shell {
		min-height: 100vh;
		background: var(--color-bg);
		color: var(--color-text);
	}

	.app-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--spacing-4) var(--spacing-8);
		border-bottom: 1px solid var(--color-border);
		gap: var(--spacing-6);
	}

	.app-brand-row {
		display: flex;
		align-items: center;
		gap: var(--spacing-6);
	}

	.app-brand {
		font-weight: 700;
		font-size: var(--text-xl);
		text-decoration: none;
		color: inherit;
	}

	.app-nav {
		display: flex;
		gap: var(--spacing-4);
		font-size: var(--text-base);
	}

	.app-nav-link {
		text-decoration: none;
		color: var(--color-text-subtle);
		font-weight: 400;
	}

	.app-nav-link.active {
		color: var(--color-text);
		font-weight: 600;
	}

	.app-user-row {
		display: flex;
		align-items: center;
		gap: var(--spacing-4);
	}

	.app-user-name {
		font-size: var(--text-base);
		color: var(--color-text-muted);
	}

	.app-main {
		padding: var(--spacing-8);
	}
</style>
