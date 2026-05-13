import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin';

/**
 * Gate the whole `/admin/*` subtree. The parent app layout already
 * redirects unauthenticated users to /login; this layer additionally
 * requires the email to be in `CANVAS_ADMIN_EMAILS`. Empty allowlist =
 * 403 for everyone.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user || !locals.session) error(401, 'Unauthorized');
	requireAdmin(locals.user);
	return { user: locals.user };
};
