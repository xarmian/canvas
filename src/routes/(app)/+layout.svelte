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
	<!--
		Skip-link (TASK-145). Hidden off-screen until focused, then
		slides into view at the top-left. Activating it jumps focus to
		`<main id="main-content">` below so keyboard / screen-reader
		users don't have to tab through the entire primary nav on
		every page load. `tabindex="-1"` on the target ensures focus
		actually lands there (some engines won't auto-focus a non-
		interactive landmark on fragment navigation; the explicit
		tabindex makes the behavior deterministic).
	-->
	<a href="#main-content" class="skip-link">Skip to main content</a>
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
	<main id="main-content" class="app-main" tabindex="-1">
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

	/*
	 * Native programmatic-focus outline on a tabindex="-1" <main> is
	 * a visible focus ring that lingers after the skip-link jump.
	 * Removing it keeps the page chrome clean once the user has
	 * landed; the actual focused content inside `<main>` still gets
	 * its own focus indicator on the next Tab.
	 */
	.app-main:focus {
		outline: none;
	}

	/*
	 * Skip-link. Hidden off-screen by default — kept in the DOM (not
	 * `display: none`) so it's reachable by Tab and announced by
	 * screen readers as the first interactive element on the page.
	 * Slides into view on focus.
	 */
	.skip-link {
		position: absolute;
		top: var(--spacing-2);
		left: var(--spacing-2);
		padding: var(--spacing-2) var(--spacing-4);
		background: var(--color-primary);
		color: var(--color-bg);
		font-size: var(--text-base);
		font-weight: 600;
		text-decoration: none;
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		z-index: 100;
		/* Pull off-screen until focused. transform (not `top: -9999px`)
		   so the slide-in transition reads as motion when keyboard
		   users land on it, signalling that something appeared. */
		transform: translateY(calc(-100% - var(--spacing-4)));
		transition: transform 0.15s ease;
	}

	.skip-link:focus,
	.skip-link:focus-visible {
		transform: translateY(0);
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}
</style>
