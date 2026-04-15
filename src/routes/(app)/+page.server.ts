import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { canvases } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals }) => {
	const userCanvases = await db
		.select({
			id: canvases.id,
			name: canvases.name,
			slug: canvases.slug,
			width: canvases.width,
			height: canvases.height,
			published: canvases.published,
			updatedAt: canvases.updatedAt
		})
		.from(canvases)
		.where(eq(canvases.userId, locals.user!.id))
		.orderBy(desc(canvases.updatedAt));

	return { canvases: userCanvases };
};
