<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import { goto } from '$app/navigation';

	let { data, children } = $props();

	async function handleLogout() {
		await authClient.signOut();
		goto('/login');
	}
</script>

<div style="min-height: 100vh;">
	<header
		style="display: flex; justify-content: space-between; align-items: center; padding: 1rem 2rem; border-bottom: 1px solid #e5e7eb;"
	>
		<a
			href="/"
			style="font-weight: bold; font-size: 1.25rem; text-decoration: none; color: inherit;"
			>Canvas</a
		>
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
