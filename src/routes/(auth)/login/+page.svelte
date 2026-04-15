<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client';

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		loading = true;

		try {
			const result = await authClient.signIn.email({ email, password });

			if (result.error) {
				error = result.error.message ?? 'Login failed. Please try again.';
			} else {
				await goto('/');
			}
		} catch {
			error = 'An unexpected error occurred. Please try again.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Log in | Canvas</title>
</svelte:head>

<div style="display: flex; justify-content: center; align-items: center; min-height: 100vh;">
	<div style="width: 100%; max-width: 400px; padding: 2rem;">
		<h1 style="text-align: center; margin-bottom: 1.5rem;">Log in</h1>

		{#if error}
			<p
				style="color: #dc2626; background: #fef2f2; padding: 0.75rem; border-radius: 4px; margin-bottom: 1rem;"
			>
				{error}
			</p>
		{/if}

		<form onsubmit={handleSubmit}>
			<div style="margin-bottom: 1rem;">
				<label for="email" style="display: block; margin-bottom: 0.25rem; font-weight: 500;"
					>Email</label
				>
				<input
					id="email"
					type="email"
					bind:value={email}
					required
					autocomplete="email"
					style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;"
				/>
			</div>

			<div style="margin-bottom: 1.5rem;">
				<label for="password" style="display: block; margin-bottom: 0.25rem; font-weight: 500;"
					>Password</label
				>
				<input
					id="password"
					type="password"
					bind:value={password}
					required
					autocomplete="current-password"
					style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;"
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				style="width: 100%; padding: 0.625rem; background: #111; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 1rem;"
			>
				{loading ? 'Logging in...' : 'Log in'}
			</button>
		</form>

		<p style="text-align: center; margin-top: 1rem;">
			Don't have an account? <a href="/signup">Sign up</a>
		</p>
	</div>
</div>
