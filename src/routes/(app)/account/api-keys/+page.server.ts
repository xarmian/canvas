import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getApiKeyRenderUsageBatch } from '$lib/server/render-events';

/**
 * Server-side load for the API keys management page. We never return
 * `hashedSecret` to the browser — only the user-facing fields. Revoked
 * keys are returned by default so the table can render the "Revoked"
 * badge and a soft history of past keys; the client toggles visibility.
 *
 * Per-key 30-day usage counters (TASK-197) come from
 * `getApiKeyRenderUsageBatch` — ONE additional query for the whole
 * list. Revoked keys still get historical counts because
 * `render_events` doesn't care about `revokedAt` (events outlive the
 * key they were issued from).
 */
export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;
	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			scopes: apiKeys.scopes,
			lastUsedAt: apiKeys.lastUsedAt,
			revokedAt: apiKeys.revokedAt,
			createdAt: apiKeys.createdAt
		})
		.from(apiKeys)
		.where(eq(apiKeys.userId, userId))
		.orderBy(desc(apiKeys.createdAt));

	// Single batched query — N keys, 1 SQL roundtrip. Empty-id list is
	// short-circuited by the helper, so a user with zero keys pays
	// nothing for the lookup.
	const usageByKey = await getApiKeyRenderUsageBatch(rows.map((r) => r.id));
	const keys = rows.map((r) => {
		const usage = usageByKey.get(r.id) ?? { total: 0, last429At: null, lastErrorAt: null };
		return {
			...r,
			requestCount: usage.total,
			last429At: usage.last429At,
			lastErrorAt: usage.lastErrorAt
		};
	});

	return { keys };
};
