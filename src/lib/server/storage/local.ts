import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import type { StorageAdapter } from './types.js';

/**
 * Local filesystem storage adapter for development without Docker/MinIO.
 * Files are stored in .local-storage/ (gitignored).
 */
export class LocalStorageAdapter implements StorageAdapter {
	private basePath: string;
	private publicPrefix: string;

	constructor(basePath?: string) {
		this.basePath = basePath || join(process.cwd(), '.local-storage');
		this.publicPrefix = '/api/assets';

		if (!existsSync(this.basePath)) {
			mkdirSync(this.basePath, { recursive: true });
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async upload(key: string, body: Buffer, contentType: string): Promise<string> {
		const filePath = join(this.basePath, key);
		const dir = dirname(filePath);

		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		writeFileSync(filePath, body);
		return this.getUrl(key);
	}

	getUrl(key: string): string {
		return `${this.publicPrefix}/${key}`;
	}

	async delete(key: string): Promise<void> {
		const filePath = join(this.basePath, key);
		if (existsSync(filePath)) {
			unlinkSync(filePath);
		}
	}
}
