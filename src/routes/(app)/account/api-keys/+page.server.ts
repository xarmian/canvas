import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKeys } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';

/**
 * Server-side load for the API keys management page. We never return
 * `hashedSecret` to the browser — only the user-facing fields. Revoked
 * keys are returned by default so the table can render the "Revoked"
 * badge and a soft history of past keys; the client toggles visibility.
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

	return { keys: rows };
};
