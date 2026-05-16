import { error } from '@sveltejs/kit';
import { eq, max } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { session, user } from '$lib/server/db/schema';

/**
 * Per-user admin drilldown — scaffold (TASK-181 / PLAN-180).
 *
 * Admin gating is inherited from `(app)/admin/+layout.server.ts` (the
 * shared `requireAdmin(locals.user)` check). We intentionally don't
 * re-check here so the gate stays single-source — change the parent
 * layout, every admin page follows.
 *
 * v1 scaffold returns a minimal user payload + typed empty stubs for
 * the sections downstream tasks (TASK-182..187) will hydrate, so the
 * page renders end-to-end before substance lands.
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

	// Hydrated by TASK-183 (per-user storage stat tiles).
	const storageStats = {
		renderCount: 0,
		totalBytes: 0,
		oldestAt: null as string | null,
		mostRecentAt: null as string | null
	};

	type RecentRender = {
		id: string;
		shortId: string;
		createdAt: string;
		sizeBytes: number;
	};
	// Hydrated by TASK-184 (recently-used renders table).
	const recentRenders: RecentRender[] = [];

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
