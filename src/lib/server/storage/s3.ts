import {
	S3Client,
	PutObjectCommand,
	DeleteObjectCommand,
	type S3ClientConfig
} from '@aws-sdk/client-s3';
import type { StorageAdapter } from './types.js';

export interface S3StorageConfig {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
	region: string;
	/** Public base URL for accessing stored files. Defaults to endpoint/bucket. */
	publicUrl?: string;
}

export class S3StorageAdapter implements StorageAdapter {
	private client: S3Client;
	private bucket: string;
	private publicBaseUrl: string;

	constructor(config: S3StorageConfig) {
		const clientConfig: S3ClientConfig = {
			endpoint: config.endpoint,
			region: config.region,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey
			},
			forcePathStyle: true // Required for MinIO
		};

		this.client = new S3Client(clientConfig);
		this.bucket = config.bucket;
		this.publicBaseUrl = config.publicUrl || `${config.endpoint}/${config.bucket}`;
	}

	async upload(key: string, body: Buffer, contentType: string): Promise<string> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: body,
				ContentType: contentType
			})
		);

		return this.getUrl(key);
	}

	getUrl(key: string): string {
		return `${this.publicBaseUrl}/${key}`;
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: key
			})
		);
	}
}
