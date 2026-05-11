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
	/** When set, public URLs point directly at this base (e.g. a
	 *  CloudFront / Cloudflare / public MinIO host). When unset, public
	 *  URLs are routed through the app's `/api/assets/{key}` proxy. */
	private publicBaseUrl: string | null;

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
		// Only opt INTO direct serving when an operator explicitly
		// configures `S3_PUBLIC_URL`. The previous fallback of
		// `${endpoint}/${bucket}` (e.g. `http://localhost:9002/canvas`)
		// leaked the storage hostname into every `<img>` URL the editor
		// rendered, which broke whenever the dev server was reached
		// from anything other than localhost AND required public CORS
		// on the bucket (BT-154). Default is to proxy through the app
		// — same-origin, no CORS surface, no hostname dependency.
		this.publicBaseUrl = config.publicUrl ?? null;
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
		// When an operator has configured a public base (CDN or
		// publicly-reachable MinIO), use it directly. Otherwise route
		// through the app proxy — see constructor for rationale.
		if (this.publicBaseUrl) return `${this.publicBaseUrl}/${key}`;
		return `/api/assets/${key}`;
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
