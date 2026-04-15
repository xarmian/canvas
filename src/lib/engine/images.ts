import { Image } from '@napi-rs/canvas';

/** Simple LRU-ish cache for fetched remote images */
const imageCache = new Map<string, { buffer: Buffer; timestamp: number }>();
const MAX_CACHE_SIZE = 200;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Loads a remote image by URL with timeout and caching.
 * Returns null on failure (timeout, 404, network error).
 */
export async function loadRemoteImage(
	url: string,
	timeoutMs: number = 3000
): Promise<Image | null> {
	try {
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
			const res = await fetch(url, { signal: controller.signal });
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
