import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assets } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getStorage } from '$lib/server/storage';

/**
 * Proxies stored asset bytes back to the browser.
 *
 * Pre-BT-154 this endpoint was a local-storage-only fallback: in S3
 * mode the editor served `<img src>` URLs that pointed *directly* at
 * MinIO/S3 (`http://localhost:9002/canvas/...`). That coupled every
 * client to the storage host's address + required CORS to be wide open
 * on the bucket, and silently broke any access path where the browser
 * wasn't on the same host as MinIO (LAN dev, Cloud Code, remote
 * preview, etc.).
 *
 * The fix flips the default — `storage.getUrl(key)` now returns
 * `/api/assets/{key}` for both LocalStorage and S3StorageAdapter unless
 * the operator has explicitly configured `S3_PUBLIC_URL` (a CDN /
 * publicly-reachable bucket). Same-origin, no CORS surface, no
 * hostname dependency. Reading the bytes still uses the storage
 * adapter's `read()` method, which talks to MinIO/S3 via the AWS SDK
 * (or the filesystem for LocalStorage) over the server-side network —
 * the browser never reaches MinIO directly.
 *
 * Auth model: anything under the `public/` key prefix is anonymously
 * readable (matches what MinIO's bucket policy used to grant); the
 * upload route puts user-visible images under that prefix. Other
 * prefixes (none today; reserved for future private assets) require
 * an authenticated session.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const storageKey = params.path;
	if (!storageKey) error(404, 'Asset not found');

	// Public-prefix gate. Mirrors what the previous MinIO bucket policy
	// granted: only `public/...` keys are anonymous-readable. Anything
	// else requires an authenticated session.
	const isPublic = storageKey.startsWith('public/');
	if (!isPublic && !locals.user) error(401, 'Unauthorized');

	// Look up the asset row to pull the canonical content-type and to
	// confirm the storage key actually exists. The DB is the source of
	// truth for MIME — using `Content-Type` from S3/MinIO directly would
	// trust whatever the client said at upload time.
	const [asset] = await db
		.select({
			contentType: assets.contentType,
			userId: assets.userId
		})
		.from(assets)
		.where(eq(assets.storageKey, storageKey))
		.limit(1);

	if (!asset) error(404, 'Asset not found');

	// Private assets (future): only the owner can read them. Today no
	// upload path produces a non-public key, so this branch is
	// defensive; keeps the auth model sound if/when private assets land.
	if (!isPublic && asset.userId !== locals.user!.id) error(403, 'Forbidden');

	const storage = getStorage();
	let buffer: Buffer;
	try {
		buffer = await storage.read(storageKey);
	} catch (err) {
		// Storage object missing (deleted out-of-band, replication lag,
		// MinIO down). Surface as 404 rather than 500 so the editor's
		// "broken asset" UX is consistent regardless of backend.
		console.error('[api/assets] storage.read failed', { storageKey, err });
		error(404, 'Asset bytes not found');
	}

	const headers: Record<string, string> = {
		'Content-Type': asset.contentType || 'application/octet-stream',
		// Storage keys embed a nanoid per upload — different bytes
		// always live at a different URL, so the response is safe to
		// cache immutably and aggressively.
		'Cache-Control': 'public, max-age=31536000, immutable',
		// SVG is the one image type that can execute scripts when
		// rendered inline. CSP + nosniff + force-download keep a
		// poisoned SVG from running in the app origin even if a user
		// somehow uploads one that survived our content-type check.
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
		'X-Content-Type-Options': 'nosniff'
	};
	if (asset.contentType === 'image/svg+xml') {
		headers['Content-Disposition'] = 'attachment';
	}

	return new Response(new Uint8Array(buffer), { headers });
};
