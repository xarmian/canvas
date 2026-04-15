<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client';

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		loading = true;

		try {
			const result = await authClient.signUp.email({ name, email, password });

			if (result.error) {
				error = result.error.message ?? 'Signup failed. Please try again.';
			} else {
				await goto('/');
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An unexpected error occurred.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Sign up | Canvas</title>
</svelte:head>

<div style="display:flex; justify-content:center; align-items:center; min-height:100vh;">
	<div style="width:100%; max-width:400px; padding:2rem;">
		<h1 style="margin-bottom:1.5rem; text-align:center;">Sign up</h1>

		{#if error}
			<p style="color:red; margin-bottom:1rem; text-align:center;">{error}</p>
		{/if}

		<form onsubmit={handleSubmit} style="display:flex; flex-direction:column; gap:1rem;">
			<label>
				<span>Name</span>
				<input
					type="text"
					bind:value={name}
					required
					autocomplete="name"
					style="display:block; width:100%; padding:0.5rem; margin-top:0.25rem; box-sizing:border-box;"
				/>
			</label>

			<label>
				<span>Email</span>
				<input
					type="email"
					bind:value={email}
					required
					autocomplete="email"
					style="display:block; width:100%; padding:0.5rem; margin-top:0.25rem; box-sizing:border-box;"
				/>
			</label>

			<label>
				<span>Password</span>
				<input
					type="password"
					bind:value={password}
					required
					minlength="8"
					autocomplete="new-password"
					style="display:block; width:100%; padding:0.5rem; margin-top:0.25rem; box-sizing:border-box;"
				/>
			</label>

			<button
				type="submit"
				disabled={loading}
				style="padding:0.75rem; cursor:pointer; margin-top:0.5rem;"
			>
				{loading ? 'Signing up...' : 'Sign up'}
			</button>
		</form>

		<p style="text-align:center; margin-top:1.5rem;">
			Already have an account? <a href="/login">Log in</a>
		</p>
	</div>
</div>
