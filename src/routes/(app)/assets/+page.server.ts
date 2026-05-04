import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { eq, and, desc, sql, like } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	// Surface only image assets in the library UI — fonts use a different
	// management surface (TASK-63).
	const imageContentType = like(assets.contentType, 'image/%');

	const rows = await db
		.select()
		.from(assets)
		.where(and(eq(assets.userId, userId), imageContentType))
		.orderBy(desc(assets.createdAt))
		.limit(PAGE_SIZE);

	const [{ total }] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(assets)
		.where(and(eq(assets.userId, userId), imageContentType));

	const storage = getStorage();
	const items = rows.map((a) => ({
		id: a.id,
		filename: a.filename,
		url: storage.getUrl(a.storageKey),
		contentType: a.contentType,
		sizeBytes: a.sizeBytes,
		createdAt: a.createdAt
	}));

	return { items, total, pageSize: PAGE_SIZE };
};
