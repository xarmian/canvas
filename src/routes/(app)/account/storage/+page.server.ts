import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { getUserRecentRenders, getUserRenderStats } from '$lib/server/render-stats';

/**
 * /account/storage — user-facing storage utilization page.
 *
 * Auth gating is provided by the section `+layout.server.ts` (which itself
 * defers to the app-shell layout's session-only gate). We just read the
 * stats here.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	// Aggregate stats + recent renders are shared with /admin/users/[id]
	// so the two pages stay in sync on what counts as a live render.
	const stats = await getUserRenderStats(userId);
	const recent = await getUserRecentRenders(userId);

	const quota = Number((env as Record<string, string | undefined>).RENDER_QUOTA_PER_USER ?? 1000);

	return { stats, quota, recent };
};
