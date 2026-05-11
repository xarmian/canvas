<script lang="ts">
	import PublicHeader from '$lib/components/layout/PublicHeader.svelte';

	let { children } = $props();
</script>

<!--
	Auth pages (login / signup) share the public landing-page chrome
	(BT-155). Before this, the (auth) layout shipped without any nav and
	visitors had no way to get back to the homepage short of editing the
	URL. The brand + GitHub + Log in + Sign up header lives in
	`$lib/components/layout/PublicHeader.svelte` so the visual treatment
	stays identical to `/`.

	Skip-link mirrors the (app) layout pattern (TASK-145): now that nav
	exists above <main>, keyboard / screen-reader users benefit from being
	able to jump past it on every page load. The auth shell is a flex
	column with `min-height: 100vh` so the auth pages' card wrappers can
	`flex: 1` and center themselves in whatever space remains below the
	header.
-->
<div class="auth-shell">
	<a href="#main-content" class="skip-link">Skip to main content</a>
	<PublicHeader />
	<main id="main-content" class="auth-main" tabindex="-1">
		{@render children()}
	</main>
</div>

<style>
	.auth-shell {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		background: linear-gradient(180deg, #f8fafc 0%, #fff 35%);
	}

	.auth-main {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	/*
	 * Native programmatic-focus outline on a tabindex="-1" <main> is a
	 * visible focus ring that lingers after the skip-link jump. Matches
	 * the (app) layout's treatment.
	 */
	.auth-main:focus {
		outline: none;
	}

	/*
	 * Skip-link. Hidden off-screen by default — kept in the DOM (not
	 * `display: none`) so it's reachable by Tab and announced by screen
	 * readers as the first interactive element on the page. Same
	 * visual treatment + transition as the (app) layout for
	 * consistency.
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
