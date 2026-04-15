import { Image } from '@napi-rs/canvas';

/** Simple LRU-ish cache for fetched remote images */
const imageCache = new Map<string, { buffer: Buffer; timestamp: number }>();
const MAX_CACHE_SIZE = 200;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Validates that a URL is safe to fetch (prevents SSRF).
 * Only allows http/https schemes and blocks private/internal network addresses.
 */
function isUrlSafe(url: string): boolean {
	try {
		const parsed = new URL(url);

		// Only allow http and https
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return false;
		}

		// Strip IPv6 brackets: URL.hostname returns "[::1]" for IPv6, normalize to "::1"
		const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

		// Block private/internal IP ranges and localhost
		if (
			hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '::1' ||
			hostname === '0.0.0.0' ||
			hostname.startsWith('fe80:') || // IPv6 link-local
			hostname.startsWith('fc00:') || // IPv6 unique local
			hostname.startsWith('fd') || // IPv6 unique local
			hostname.startsWith('10.') ||
			hostname.startsWith('172.16.') ||
			hostname.startsWith('172.17.') ||
			hostname.startsWith('172.18.') ||
			hostname.startsWith('172.19.') ||
			hostname.startsWith('172.2') ||
			hostname.startsWith('172.30.') ||
			hostname.startsWith('172.31.') ||
			hostname.startsWith('192.168.') ||
			hostname.endsWith('.local') ||
			hostname.endsWith('.internal') ||
			hostname === 'metadata.google.internal' ||
			hostname === '169.254.169.254' // AWS/GCP metadata endpoint
		) {
			return false;
		}

		return true;
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
		if (!isUrlSafe(url)) {
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

			const buffer = Buffer.from(await res.arrayBuffer());
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
