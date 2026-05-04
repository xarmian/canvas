<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client';

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let errorAction = $state<{ href: string; label: string } | null>(null);
	let loading = $state(false);
	/** Once the user has tried to submit, switch to live validation so
	 * inline hints update on every keystroke. Before first submit we
	 * keep things quiet — typing "a" into email shouldn't get scolded. */
	let submitted = $state(false);

	const PASSWORD_MIN = 8;
	const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	let emailLooksValid = $derived(email === '' || EMAIL_RE.test(email));
	let passwordLong = $derived(password.length >= PASSWORD_MIN);

	let emailHint = $derived.by(() => {
		if (!submitted) return '';
		if (email === '') return 'Enter your email address.';
		if (!emailLooksValid) return "That doesn't look like a valid email.";
		return '';
	});
	let passwordHint = $derived.by(() => {
		if (!submitted) return '';
		if (!passwordLong) return `At least ${PASSWORD_MIN} characters.`;
		return '';
	});

	let formValid = $derived(name.trim() !== '' && emailLooksValid && passwordLong);

	/** Map raw Better Auth error responses to friendly copy. The shipped
	 * v0.1 surface dumped the raw error.message, which on duplicate-email
	 * was technical-feeling. */
	function mapError(rawMessage: string | undefined): {
		message: string;
		action: { href: string; label: string } | null;
	} {
		const msg = rawMessage?.toLowerCase() ?? '';
		// Better Auth's duplicate-email response varies across versions;
		// match liberally on common substrings.
		if (
			msg.includes('email already') ||
			msg.includes('user already') ||
			msg.includes('already exists') ||
			msg.includes('already registered') ||
			msg.includes('duplicate')
		) {
			return {
				message: 'An account already exists with that email.',
				action: { href: '/login', label: 'Log in instead' }
			};
		}
		if (msg.includes('password')) {
			return {
				message: `Choose a stronger password (${PASSWORD_MIN}+ characters).`,
				action: null
			};
		}
		if (msg.includes('invalid email')) {
			return { message: 'Please enter a valid email address.', action: null };
		}
		// Fall through — surface the raw text but lightly cleaned.
		return {
			message: rawMessage?.trim() || 'Signup failed. Please try again.',
			action: null
		};
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		submitted = true;
		error = '';
		errorAction = null;

		if (!formValid) return;

		loading = true;
		try {
			const result = await authClient.signUp.email({ name, email, password });
			if (result.error) {
				const mapped = mapError(result.error.message);
				error = mapped.message;
				errorAction = mapped.action;
			} else {
				await goto('/');
			}
		} catch (err) {
			const raw = err instanceof Error ? err.message : undefined;
			const mapped = mapError(raw);
			error = mapped.message;
			errorAction = mapped.action;
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Sign up | Canvas</title>
</svelte:head>

<div class="signup-page">
	<div class="signup-card">
		<h1>Sign up</h1>

		{#if error}
			<div class="alert" role="alert">
				<span>{error}</span>
				{#if errorAction}
					<a href={errorAction.href} class="alert-link">{errorAction.label}</a>
				{/if}
			</div>
		{/if}

		<form onsubmit={handleSubmit} novalidate>
			<label class="field">
				<span>Name</span>
				<input type="text" bind:value={name} required autocomplete="name" />
			</label>

			<label class="field">
				<span>Email</span>
				<input
					type="email"
					bind:value={email}
					required
					autocomplete="email"
					aria-invalid={emailHint ? 'true' : 'false'}
					aria-describedby={emailHint ? 'email-hint' : undefined}
					class:invalid={!!emailHint}
				/>
				{#if emailHint}
					<span id="email-hint" class="hint hint-error">{emailHint}</span>
				{/if}
			</label>

			<label class="field">
				<span>Password</span>
				<input
					type="password"
					bind:value={password}
					required
					autocomplete="new-password"
					aria-invalid={passwordHint ? 'true' : 'false'}
					aria-describedby="password-hint"
					class:invalid={!!passwordHint}
				/>
				<span
					id="password-hint"
					class="hint"
					class:hint-error={!!passwordHint}
					class:hint-ok={password.length > 0 && passwordLong}
				>
					{#if password.length === 0}
						At least {PASSWORD_MIN} characters.
					{:else if passwordLong}
						✓ Strong enough.
					{:else}
						{passwordHint || `At least ${PASSWORD_MIN} characters.`}
					{/if}
				</span>
			</label>

			<button type="submit" class="submit-btn" disabled={loading || (submitted && !formValid)}>
				{loading ? 'Signing up…' : 'Sign up'}
			</button>
		</form>

		<p class="footer">
			Already have an account? <a href="/login">Log in</a>
		</p>
	</div>
</div>

<style>
	.signup-page {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		padding: 1.5rem;
		background: #f8fafc;
	}

	.signup-card {
		width: 100%;
		max-width: 420px;
		padding: 2rem;
		background: #fff;
		border: 1px solid #e2e8f0;
		border-radius: 10px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
	}

	h1 {
		margin: 0 0 1.25rem;
		font-size: 1.4rem;
		text-align: center;
	}

	.alert {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-bottom: 1rem;
		padding: 0.7rem 0.85rem;
		background: #fef2f2;
		border: 1px solid #fecaca;
		border-radius: 6px;
		color: #991b1b;
		font-size: 0.875rem;
		line-height: 1.45;
	}

	.alert-link {
		font-weight: 600;
		color: #b91c1c;
		text-decoration: underline;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.field > span:first-child {
		font-size: 0.8125rem;
		font-weight: 600;
		color: #1e293b;
	}

	.field input {
		padding: 0.55rem 0.7rem;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 0.9rem;
		background: #fff;
	}

	.field input:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
	}

	.field input.invalid {
		border-color: #dc2626;
	}

	.hint {
		font-size: 0.75rem;
		color: #64748b;
	}

	.hint-error {
		color: #b91c1c;
	}

	.hint-ok {
		color: #166534;
	}

	.submit-btn {
		margin-top: 0.5rem;
		padding: 0.7rem;
		border: none;
		border-radius: 6px;
		background: #2563eb;
		color: #fff;
		font-size: 0.9rem;
		font-weight: 500;
		cursor: pointer;
	}

	.submit-btn:hover:not(:disabled) {
		background: #1d4ed8;
	}

	.submit-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.footer {
		margin: 1.25rem 0 0;
		text-align: center;
		font-size: 0.875rem;
		color: #475569;
	}

	.footer a {
		color: #2563eb;
	}
</style>
