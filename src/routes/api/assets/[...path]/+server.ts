import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { readFileSync, existsSync } from 'fs';
import { resolve, sep } from 'path';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Serves locally stored assets when using STORAGE_LOCAL=true.
 * In production (S3/MinIO), assets are served directly by the storage service.
 */
export const GET: RequestHandler = async ({ params }) => {
	if (env.STORAGE_LOCAL !== 'true') {
		error(404, 'Local asset serving is only available with STORAGE_LOCAL=true');
	}

	const storageRoot = resolve(process.cwd(), '.local-storage');
	const filePath = resolve(storageRoot, params.path);

	// Enforce directory boundary (resolve + sep prevents prefix-only matches)
	if (!filePath.startsWith(storageRoot + sep)) {
		error(403, 'Forbidden');
	}

	if (!existsSync(filePath)) {
		error(404, 'Asset not found');
	}

	// Look up the stored content type from the database to prevent MIME mismatches
	const storageKey = params.path;
	const [asset] = await db
		.select({ contentType: assets.contentType })
		.from(assets)
		.where(eq(assets.storageKey, storageKey))
		.limit(1);

	const contentType = asset?.contentType || 'application/octet-stream';
	const buffer = readFileSync(filePath);

	const headers: Record<string, string> = {
		'Content-Type': contentType,
		'Cache-Control': 'public, max-age=31536000, immutable',
		// Prevent scriptable content (SVG) from executing in the app origin
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
		'X-Content-Type-Options': 'nosniff'
	};

	// Force download for SVGs to prevent inline script execution
	if (contentType === 'image/svg+xml') {
		headers['Content-Disposition'] = 'attachment';
	}

	return new Response(buffer, { headers });
};
