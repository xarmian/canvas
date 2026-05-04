<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

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

<div style="min-height: 100vh;">
	<header
		style="display: flex; justify-content: space-between; align-items: center; padding: 1rem 2rem; border-bottom: 1px solid #e5e7eb; gap: 1.5rem;"
	>
		<div style="display: flex; align-items: center; gap: 1.5rem;">
			<a
				href="/"
				style="font-weight: bold; font-size: 1.25rem; text-decoration: none; color: inherit;"
				>Canvas</a
			>
			<nav aria-label="Primary" style="display: flex; gap: 1rem; font-size: 0.9rem;">
				<a
					href="/"
					data-testid="nav-dashboard"
					aria-current={pathname === '/' ? 'page' : undefined}
					style="text-decoration: none; color: {pathname === '/' ? '#111' : '#64748b'}; font-weight: {pathname === '/' ? 600 : 400};"
				>
					Dashboard
				</a>
				<a
					href="/assets"
					data-testid="nav-assets"
					aria-current={pathname.startsWith('/assets') ? 'page' : undefined}
					style="text-decoration: none; color: {pathname.startsWith('/assets') ? '#111' : '#64748b'}; font-weight: {pathname.startsWith('/assets') ? 600 : 400};"
				>
					Assets
				</a>
			</nav>
		</div>
		<div style="display: flex; align-items: center; gap: 1rem;">
			<span>{data.user?.name ?? data.user?.email}</span>
			<button
				onclick={handleLogout}
				style="padding: 0.5rem 1rem; background: none; border: 1px solid #d1d5db; border-radius: 0.375rem; cursor: pointer;"
			>
				Log out
			</button>
		</div>
	</header>
	<main style="padding: 2rem;">
		{@render children()}
	</main>
</div>
