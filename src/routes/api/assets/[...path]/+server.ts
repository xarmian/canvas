import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { lookup } from 'mime-types';

/**
 * Serves locally stored assets when using STORAGE_LOCAL=true.
 * In production (S3/MinIO), assets are served directly by the storage service.
 */
export const GET: RequestHandler = async ({ params }) => {
	if (env.STORAGE_LOCAL !== 'true') {
		error(404, 'Local asset serving is only available with STORAGE_LOCAL=true');
	}

	const filePath = join(process.cwd(), '.local-storage', params.path);

	// Prevent path traversal
	const resolved = join(process.cwd(), '.local-storage');
	if (!filePath.startsWith(resolved)) {
		error(403, 'Forbidden');
	}

	if (!existsSync(filePath)) {
		error(404, 'Asset not found');
	}

	const buffer = readFileSync(filePath);
	const contentType = lookup(filePath) || 'application/octet-stream';

	return new Response(buffer, {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
};
