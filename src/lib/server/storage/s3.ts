import {
	S3Client,
	PutObjectCommand,
	DeleteObjectCommand,
	GetObjectCommand,
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

	async read(key: string): Promise<Buffer> {
		const res = await this.client.send(
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: key
			})
		);
		if (!res.Body) {
			throw new Error(`Storage object not found: ${key}`);
		}
		// Body is a Readable stream in Node — collect into a Buffer.
		const chunks: Buffer[] = [];
		// @ts-expect-error — AsyncIterable typing differs across SDK versions.
		for await (const chunk of res.Body) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
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
