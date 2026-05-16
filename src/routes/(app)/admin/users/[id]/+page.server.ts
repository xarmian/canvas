import { error } from '@sveltejs/kit';
import { eq, max } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { session, user } from '$lib/server/db/schema';
import { getUserRecentRenders, getUserRenderStats } from '$lib/server/render-stats';

/**
 * Per-user admin drilldown (PLAN-180).
 *
 * Admin gating is inherited from `(app)/admin/+layout.server.ts` (the
 * shared `requireAdmin(locals.user)` check). We intentionally don't
 * re-check here so the gate stays single-source — change the parent
 * layout, every admin page follows.
 *
 * Hydrated sections: identity card (TASK-182), storage stat tiles
 * (TASK-183), recent renders table (TASK-184). Still stubbed: API
 * keys (TASK-187).
 */
export const load: PageServerLoad = async ({ params }) => {
	const rows = await db
		.select({
			id: user.id,
			email: user.email,
			name: user.name,
			image: user.image,
			createdAt: user.createdAt
		})
		.from(user)
		.where(eq(user.id, params.id))
		.limit(1);

	const row = rows[0];
	if (!row) error(404, 'User not found');

	// Last sign-in = MAX(session.created_at) for the target user.
	// session.created_at is set once when the session row is inserted
	// (i.e. when the user signed in); session.updated_at is bumped on
	// each authenticated request (rolling expiry) and would conflate
	// active use with sign-in. The task spec is "Last sign-in," so we
	// take created_at.
	const sessionRows = await db
		.select({ lastSignInAt: max(session.createdAt) })
		.from(session)
		.where(eq(session.userId, row.id));
	const lastSignInAt = sessionRows[0]?.lastSignInAt?.toISOString() ?? null;

	const targetUser = {
		id: row.id,
		email: row.email,
		name: row.name,
		image: row.image,
		createdAt: row.createdAt.toISOString(),
		lastSignInAt
	};

	// Reuses the same aggregate + recent-renders queries /account/storage
	// runs for the session user, scoped here to the path-param target
	// user. Keeping the queries shared (rather than forking) means the
	// two views can't drift on what counts as a "live render."
	const storageStats = await getUserRenderStats(row.id);
	const recentRenders = await getUserRecentRenders(row.id);

	type ApiKeyRow = {
		id: string;
		label: string;
		prefix: string;
		createdAt: string;
		lastUsedAt: string | null;
		revokedAt: string | null;
	};
	// Hydrated by TASK-187 (admin view of target user's API keys).
	const apiKeys: ApiKeyRow[] = [];

	return {
		targetUser,
		storageStats,
		recentRenders,
		apiKeys
	};
};
