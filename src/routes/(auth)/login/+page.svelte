<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import { Button, Input } from '$lib/components/ui';

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
				await goto('/dashboard');
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

<div class="login-page">
	<div class="login-card">
		<h1>Log in</h1>

		{#if error}
			<p class="alert" role="alert">{error}</p>
		{/if}

		<form onsubmit={handleSubmit}>
			<div class="field">
				<label for="login-email">Email</label>
				<Input id="login-email" type="email" bind:value={email} required autocomplete="email" />
			</div>

			<div class="field">
				<label for="login-password">Password</label>
				<Input
					id="login-password"
					type="password"
					bind:value={password}
					required
					autocomplete="current-password"
				/>
			</div>

			<Button variant="primary" type="submit" {loading} class="submit-btn">
				{loading ? 'Logging in…' : 'Log in'}
			</Button>
		</form>

		<p class="footer">
			Don't have an account? <a href="/signup">Sign up</a>
		</p>
	</div>
</div>

<style>
	.login-page {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		padding: var(--spacing-6);
		background: var(--color-surface);
	}

	.login-card {
		width: 100%;
		max-width: 400px;
		padding: var(--spacing-8);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-sm);
	}

	h1 {
		margin: 0 0 var(--spacing-6);
		font-size: var(--text-xl);
		text-align: center;
		color: var(--color-text);
	}

	.alert {
		margin: 0 0 var(--spacing-4);
		padding: var(--spacing-3);
		background: var(--color-danger-surface);
		border: 1px solid var(--color-danger-border);
		border-radius: var(--radius-md);
		color: var(--color-danger-hover);
		font-size: var(--text-base);
		line-height: 1.45;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--spacing-4);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--spacing-1);
	}

	.field label {
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--color-text);
	}

	/*
	 * The submit Button primitive lays out as inline-flex by default —
	 * the auth surface wants a full-width CTA, matching the page card's
	 * compact column. `:global` reaches through the primitive's scoped
	 * styles so we keep variant + focus rules from the canonical Button.
	 */
	form :global(.submit-btn) {
		width: 100%;
		margin-top: var(--spacing-2);
	}

	.footer {
		margin: var(--spacing-4) 0 0;
		text-align: center;
		font-size: var(--text-base);
		color: var(--color-text-muted);
	}

	.footer a {
		color: var(--color-primary);
	}
</style>
