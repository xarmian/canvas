/**
 * Storage adapter interface for uploaded assets (images, fonts).
 * Implementations: S3-compatible (MinIO, AWS, R2) and local filesystem.
 */
export interface StorageAdapter {
	/** Upload a file and return its public URL */
	upload(key: string, body: Buffer, contentType: string): Promise<string>;

	/** Get the public URL for a stored file */
	getUrl(key: string): string;

	/** Delete a stored file */
	delete(key: string): Promise<void>;
}

/** Allowed image MIME types */
export const ALLOWED_IMAGE_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/svg+xml'
]);

/** Allowed font MIME types */
export const ALLOWED_FONT_TYPES = new Set([
	'font/ttf',
	'font/otf',
	'font/woff',
	'font/woff2',
	'application/x-font-ttf',
	'application/x-font-otf',
	'application/font-woff',
	'application/font-woff2'
]);

/** Max file sizes in bytes */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_FONT_SIZE = 2 * 1024 * 1024; // 2MB
