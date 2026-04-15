import { env } from '$env/dynamic/private';
import type { StorageAdapter } from './types.js';
import { S3StorageAdapter } from './s3.js';
import { LocalStorageAdapter } from './local.js';

export type { StorageAdapter } from './types.js';
export { ALLOWED_IMAGE_TYPES, ALLOWED_FONT_TYPES, MAX_IMAGE_SIZE, MAX_FONT_SIZE } from './types.js';

let _storage: StorageAdapter | null = null;

/**
 * Returns the configured storage adapter (singleton).
 * Uses S3 by default, local filesystem if STORAGE_LOCAL=true.
 */
export function getStorage(): StorageAdapter {
	if (_storage) return _storage;

	if (env.STORAGE_LOCAL === 'true') {
		_storage = new LocalStorageAdapter();
	} else {
		if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY || !env.S3_BUCKET) {
			throw new Error(
				'S3 storage not configured. Set S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET in .env, or set STORAGE_LOCAL=true for local storage.'
			);
		}

		_storage = new S3StorageAdapter({
			endpoint: env.S3_ENDPOINT,
			accessKeyId: env.S3_ACCESS_KEY,
			secretAccessKey: env.S3_SECRET_KEY,
			bucket: env.S3_BUCKET,
			region: env.S3_REGION || 'us-east-1'
		});
	}

	return _storage;
}
