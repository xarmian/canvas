import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Public landing page (TASK-99).
 *
 * Replaces the previous unauth → /login redirect. Authenticated visitors
 * are redirected to the dashboard at /dashboard so they don't have to
 * click past a marketing surface every time they hit the root URL.
 *
 * The dashboard itself moved from `(app)/+page.svelte` to
 * `(app)/dashboard/+page.svelte` in this same PR; the (app) group's
 * layout.server.ts still gates that route with the /login redirect for
 * unauthenticated requests, so /dashboard remains auth-only.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(302, '/dashboard');
	}
	return {};
};
