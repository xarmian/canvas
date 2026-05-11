<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import { Button, Input } from '$lib/components/ui';

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
	let emailFilledAndValid = $derived(email !== '' && EMAIL_RE.test(email));
	let passwordLong = $derived(password.length >= PASSWORD_MIN);

	let nameHint = $derived(submitted && name.trim() === '' ? 'Enter your name.' : '');

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

	// Note: emailLooksValid is true on empty input (so the hint stays
	// quiet pre-submit). For form-validity we need the strictly-filled
	// version — otherwise an empty email could pass through to the
	// signup API call.
	let formValid = $derived(name.trim() !== '' && emailFilledAndValid && passwordLong);

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
				await goto('/dashboard');
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
			<div class="field">
				<label for="signup-name">Name</label>
				<Input
					id="signup-name"
					type="text"
					bind:value={name}
					required
					autocomplete="name"
					invalid={!!nameHint}
					describedBy={nameHint ? 'signup-name-hint' : undefined}
				/>
				{#if nameHint}
					<span id="signup-name-hint" class="hint hint-error">{nameHint}</span>
				{/if}
			</div>

			<div class="field">
				<label for="signup-email">Email</label>
				<Input
					id="signup-email"
					type="email"
					bind:value={email}
					required
					autocomplete="email"
					invalid={!!emailHint}
					describedBy={emailHint ? 'signup-email-hint' : undefined}
				/>
				{#if emailHint}
					<span id="signup-email-hint" class="hint hint-error">{emailHint}</span>
				{/if}
			</div>

			<div class="field">
				<label for="signup-password">Password</label>
				<Input
					id="signup-password"
					type="password"
					bind:value={password}
					required
					autocomplete="new-password"
					invalid={!!passwordHint}
					describedBy="signup-password-hint"
				/>
				<span
					id="signup-password-hint"
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
			</div>

			<Button
				variant="primary"
				type="submit"
				{loading}
				disabled={submitted && !formValid}
				class="submit-btn"
			>
				{loading ? 'Signing up…' : 'Sign up'}
			</Button>
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
		padding: var(--spacing-6);
		background: var(--color-surface);
	}

	.signup-card {
		width: 100%;
		max-width: 420px;
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
		display: flex;
		flex-direction: column;
		gap: var(--spacing-1);
		margin-bottom: var(--spacing-4);
		padding: var(--spacing-2) var(--spacing-3);
		background: var(--color-danger-surface);
		border: 1px solid var(--color-danger-border);
		border-radius: var(--radius-md);
		color: var(--color-danger-hover);
		font-size: var(--text-base);
		line-height: 1.45;
	}

	.alert-link {
		font-weight: 600;
		color: var(--color-danger-hover);
		text-decoration: underline;
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
		font-weight: 600;
		color: var(--color-text);
	}

	.hint {
		font-size: var(--text-xs);
		color: var(--color-text-subtle);
	}

	.hint-error {
		color: var(--color-danger-hover);
	}

	.hint-ok {
		color: var(--color-success);
	}

	/*
	 * Submit Button is full-width on the auth surface — same column rule
	 * as login. `:global` reaches through the primitive's scoped styles
	 * so variant + focus rules from the canonical Button stay intact.
	 */
	form :global(.submit-btn) {
		width: 100%;
		margin-top: var(--spacing-2);
	}

	.footer {
		margin: var(--spacing-6) 0 0;
		text-align: center;
		font-size: var(--text-base);
		color: var(--color-text-muted);
	}

	.footer a {
		color: var(--color-primary);
	}
</style>
