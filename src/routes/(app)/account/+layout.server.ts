import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * /account/* is session-only. Bearer-token holders should never see these
 * pages — see `hooks.server.ts` for why bearer auth does NOT populate
 * `locals.user`. The parent app layout already redirects unauthenticated
 * users to /login; this layer narrows further: anything that survives the
 * parent gate but lacks a real session cookie still bounces, defending
 * the boundary if the parent ever loosens.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user || !locals.session) {
		redirect(302, '/login');
	}
	return { user: locals.user };
};
