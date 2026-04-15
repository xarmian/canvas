import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { nanoid } from 'nanoid';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import {
	getStorage,
	ALLOWED_IMAGE_TYPES,
	ALLOWED_FONT_TYPES,
	MAX_IMAGE_SIZE,
	MAX_FONT_SIZE
} from '$lib/server/storage';

const ALLOWED_TYPES = new Set([...ALLOWED_IMAGE_TYPES, ...ALLOWED_FONT_TYPES]);

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		error(401, 'Unauthorized');
	}

	const formData = await request.formData();
	const file = formData.get('file');

	if (!file || !(file instanceof File)) {
		error(400, 'No file provided');
	}

	// Validate content type
	const contentType = file.type;
	if (!ALLOWED_TYPES.has(contentType)) {
		error(
			400,
			`Unsupported file type: ${contentType}. Allowed: images (PNG, JPEG, WebP, SVG) and fonts (TTF, OTF, WOFF, WOFF2).`
		);
	}

	// Validate file size
	const isFont = ALLOWED_FONT_TYPES.has(contentType);
	const maxSize = isFont ? MAX_FONT_SIZE : MAX_IMAGE_SIZE;
	const buffer = Buffer.from(await file.arrayBuffer());

	if (buffer.byteLength > maxSize) {
		const maxMB = maxSize / (1024 * 1024);
		error(400, `File too large. Maximum size: ${maxMB}MB for ${isFont ? 'fonts' : 'images'}.`);
	}

	// Sanitize filename: strip path separators and dot segments, keep only basename
	const rawName = file.name.split(/[/\\]/).pop() || 'file';
	const safeName = rawName.replace(/\.\./g, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';

	// Generate storage key under public/ prefix (publicly accessible via MinIO)
	const folder = isFont ? 'fonts' : 'images';
	const key = `public/${folder}/${nanoid()}/${safeName}`;

	// Upload to storage
	const storage = getStorage();
	const url = await storage.upload(key, buffer, contentType);

	// Save asset record
	const [asset] = await db
		.insert(assets)
		.values({
			userId: locals.user.id,
			filename: file.name,
			storageKey: key,
			contentType,
			sizeBytes: buffer.byteLength
		})
		.returning();

	return json({
		id: asset.id,
		url,
		filename: asset.filename,
		contentType: asset.contentType,
		sizeBytes: asset.sizeBytes
	});
};
