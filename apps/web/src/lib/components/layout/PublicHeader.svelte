<script lang="ts">
	/**
	 * Shared public-surface header (BT-155).
	 *
	 * Renders the brand + GitHub + Log in + Sign up nav for every
	 * non-authenticated page: the landing page (`/`), the login page
	 * (`/login`), and the signup page (`/signup`). Before this component
	 * existed, the auth pages shipped with no chrome at all — the only
	 * way back to the homepage was to manually edit the URL.
	 *
	 * Styles mirror the original `.topbar` block from the landing page
	 * verbatim, including the TASK-138 mobile-first responsive rules and
	 * the 44px tap-target minimums on every nav link. Keeping the markup
	 * and CSS identical here means the visual treatment between landing
	 * and auth pages reads as the same site.
	 *
	 * `aria-current="page"` is set on whichever link matches the current
	 * route so assistive tech can announce "current page" and so we
	 * could later tone down the redundant link with `[aria-current=page]
	 * { color: ... }` if it ever feels noisy. Keeping the redundant link
	 * visible (rather than hiding it) is intentional: the landing-page
	 * header reads as the same navigation everywhere, which is the whole
	 * point of the shared component.
	 */
	import { page } from '$app/state';

	const GITHUB_URL = 'https://github.com/xarmian/canvas';

	let pathname = $derived(page.url.pathname);
	// Match the trailing-slash variant too — SvelteKit's default config
	// strips trailing slashes but a future config change shouldn't
	// silently drop aria-current.
	let isLogin = $derived(pathname === '/login' || pathname === '/login/');
	let isSignup = $derived(pathname === '/signup' || pathname === '/signup/');
</script>

<header class="topbar">
	<a href="/" class="brand" aria-label="Canvas home">Canvas</a>
	<nav class="topnav" aria-label="Primary">
		<a href={GITHUB_URL} rel="noopener" class="topnav-link">GitHub</a>
		<a href="/login" class="topnav-link" aria-current={isLogin ? 'page' : undefined}> Log in </a>
		<a href="/signup" class="topnav-cta" aria-current={isSignup ? 'page' : undefined}> Sign up </a>
	</nav>
</header>

<style>
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		/* Mobile: 1rem horizontal padding gives the brand + 3-item nav
		   ~343px of usable width at a 375px viewport — fits comfortably
		   without horizontal scroll. The desktop 1.5rem reads better
		   on wider viewports and is restored below the breakpoint. */
		padding: 0.85rem 1rem;
		max-width: 1180px;
		margin: 0 auto;
		width: 100%;
		box-sizing: border-box;
	}

	.brand {
		font-weight: 700;
		font-size: 1.25rem;
		text-decoration: none;
		color: #0f172a;
		letter-spacing: -0.01em;
	}

	.topnav {
		display: flex;
		align-items: center;
		/* Mobile-first: tight gap keeps the 3-item nav from wrapping at
		   375px. Restored to 1rem at lg via the breakpoint block. */
		gap: 0.6rem;
	}

	.topnav-link {
		display: inline-flex;
		align-items: center;
		/* min-height: 44px ensures the tap target hits Apple HIG's
		   minimum on mobile even though the visible text is small.
		   Padding stays small so desktop reads as a nav link, not
		   a button — the height is reached via min-height alone. */
		min-height: 44px;
		padding: 0 0.25rem;
		color: #475569;
		text-decoration: none;
		/* Mobile-first: 0.85rem keeps 3 nav items + the brand on one
		   row at 375px. Restored to 0.9rem at lg. */
		font-size: 0.85rem;
		font-weight: 500;
	}

	.topnav-link:hover {
		color: #0f172a;
	}

	.topnav-cta {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.5rem 1rem;
		background: #0f172a;
		color: #fff;
		border-radius: 6px;
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 600;
	}

	@media (min-width: 640px) {
		.topbar {
			padding: 1rem 1.5rem;
		}
	}

	@media (min-width: 880px) {
		.topnav {
			gap: 1rem;
		}
		.topnav-link {
			font-size: 0.9rem;
		}
	}
</style>
