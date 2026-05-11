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
		// configures `S3_PUBLIC_URL` to point at something OTHER than
		// the endpoint+bucket the app itself talks to. Reasoning:
		//
		//   - Pre-BT-154 `.env.example` shipped with
		//     `S3_PUBLIC_URL="http://localhost:9002/canvas"`, which the
		//     old `getUrl()` would mirror back into every `<img>` src.
		//     Anyone who copied that .env (or whose dotfile already has
		//     it set to the legacy default) still has the URL leak we
		//     just fixed, because their explicit value bypasses the
		//     proxy default we just introduced (Codex round 3 P1).
		//   - A legitimate production opt-in points at a CDN / Cloudflare
		//     / publicly-reachable host that is NOT the same as the
		//     server-side S3 endpoint. The endpoint here is what the
		//     app uses internally (often `http://minio:9000` inside
		//     Docker); if the operator's "public URL" matches that
		//     internal address verbatim, it's almost certainly the
		//     legacy buggy default, not a deliberate CDN.
		//
		// So: treat `${endpoint}/${bucket}` as a sentinel that signals
		// "no real public host configured" and route through the proxy
		// in that case. Anything else is treated as a real CDN opt-in.
		const legacyBuggyDefault = `${config.endpoint.replace(/\/+$/, '')}/${config.bucket}`;
		const configured = config.publicUrl?.replace(/\/+$/, '') ?? null;
		this.publicBaseUrl = configured && configured !== legacyBuggyDefault ? configured : null;
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
