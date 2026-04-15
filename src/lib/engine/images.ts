import { Image } from '@napi-rs/canvas';
import { resolve as dnsResolve } from 'dns/promises';
import { isIP } from 'net';

/** Simple LRU-ish cache for fetched remote images */
const imageCache = new Map<string, { buffer: Buffer; timestamp: number }>();
const MAX_CACHE_SIZE = 200;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB max image size

/**
 * Checks whether an IP address is private/internal.
 */
function isPrivateIp(ip: string): boolean {
	return (
		ip === '127.0.0.1' ||
		ip === '::1' ||
		ip === '0.0.0.0' ||
		ip.startsWith('10.') ||
		ip.startsWith('172.16.') ||
		ip.startsWith('172.17.') ||
		ip.startsWith('172.18.') ||
		ip.startsWith('172.19.') ||
		ip.startsWith('172.2') ||
		ip.startsWith('172.30.') ||
		ip.startsWith('172.31.') ||
		ip.startsWith('192.168.') ||
		ip.startsWith('169.254.') ||
		ip.startsWith('fe80:') || // IPv6 link-local
		ip.startsWith('fc00:') || // IPv6 unique local
		ip.startsWith('fd00:') || // IPv6 unique local (fd00::/8)
		ip === '::' ||
		ip === '0:0:0:0:0:0:0:0' ||
		ip === '0:0:0:0:0:0:0:1'
	);
}

/**
 * Validates that a URL is safe to fetch (prevents SSRF).
 * Only allows http/https schemes and blocks private/internal network addresses.
 * Resolves DNS to verify the target IP is not private.
 */
async function isUrlSafe(url: string): Promise<boolean> {
	try {
		const parsed = new URL(url);

		// Only allow http and https
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return false;
		}

		// Strip IPv6 brackets: URL.hostname returns "[::1]" for IPv6, normalize to "::1"
		const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

		// Block known private hostnames
		if (
			hostname === 'localhost' ||
			hostname.endsWith('.local') ||
			hostname.endsWith('.internal') ||
			hostname === 'metadata.google.internal'
		) {
			return false;
		}

		// If hostname is already an IP, check it directly
		if (isIP(hostname)) {
			return !isPrivateIp(hostname);
		}

		// Resolve DNS and check all resulting IPs
		try {
			const addresses = await dnsResolve(hostname);
			if (addresses.length === 0) return false;
			return !addresses.some((addr) => isPrivateIp(addr));
		} catch {
			// DNS resolution failed — block the request
			return false;
		}
	} catch {
		return false;
	}
}

/**
 * Loads a remote image by URL with timeout and caching.
 * Returns null on failure (timeout, 404, network error, or unsafe URL).
 */
export async function loadRemoteImage(
	url: string,
	timeoutMs: number = 3000
): Promise<Image | null> {
	try {
		// Validate URL to prevent SSRF
		if (!(await isUrlSafe(url))) {
			return null;
		}

		// Check cache
		const cached = imageCache.get(url);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			const img = new Image();
			img.src = cached.buffer;
			return img;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
			if (!res.ok) return null;

			// Enforce max image size to prevent OOM
			const contentLength = res.headers.get('content-length');
			if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
				return null;
			}

			// Stream-read with size limit
			const chunks: Uint8Array[] = [];
			let totalBytes = 0;
			const reader = res.body?.getReader();
			if (!reader) return null;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > MAX_IMAGE_BYTES) {
					reader.cancel();
					return null;
				}
				chunks.push(value);
			}

			const buffer = Buffer.concat(chunks);
			const img = new Image();
			img.src = buffer;

			// Cache the buffer
			if (imageCache.size >= MAX_CACHE_SIZE) {
				// Remove oldest entry
				const firstKey = imageCache.keys().next().value;
				if (firstKey) imageCache.delete(firstKey);
			}
			imageCache.set(url, { buffer, timestamp: Date.now() });

			return img;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

/**
 * Loads an image from a Buffer (for locally stored assets).
 */
export function loadImageFromBuffer(buffer: Buffer): Image {
	const img = new Image();
	img.src = buffer;
	return img;
}

/**
 * Loads multiple images in parallel, returning null for any that fail.
 */
export async function loadImagesParallel(
	urls: string[],
	timeoutMs: number = 3000
): Promise<Map<string, Image | null>> {
	const results = await Promise.allSettled(urls.map((url) => loadRemoteImage(url, timeoutMs)));

	const imageMap = new Map<string, Image | null>();
	urls.forEach((url, i) => {
		const result = results[i];
		imageMap.set(url, result.status === 'fulfilled' ? result.value : null);
	});

	return imageMap;
}
