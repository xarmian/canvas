import { Image } from '@napi-rs/canvas';
import { resolve4, resolve6 } from 'dns/promises';
import { isIP } from 'net';

/** Simple LRU-ish cache for fetched remote images */
const imageCache = new Map<string, { buffer: Buffer; timestamp: number }>();
const MAX_CACHE_SIZE = 200;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB max image size

/**
 * Checks whether an IPv4 address is private/internal.
 */
function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4 || parts.some((p) => isNaN(p))) return true; // malformed → block

	const [a, b] = parts;
	return (
		a === 0 || // 0.0.0.0/8
		a === 10 || // 10.0.0.0/8
		a === 127 || // 127.0.0.0/8
		(a === 169 && b === 254) || // 169.254.0.0/16 (link-local, AWS metadata)
		(a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
		(a === 192 && b === 168) // 192.168.0.0/16
	);
}

/**
 * Checks whether an IPv6 address is private/internal.
 * Covers loopback (::1), link-local (fe80::/10), and ULA (fc00::/7).
 */
function isPrivateIPv6(ip: string): boolean {
	const normalized = ip.toLowerCase();
	// Check for IPv4-mapped IPv6 (::ffff:x.x.x.x) — validate the embedded IPv4
	const v4MappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (v4MappedMatch) {
		return isPrivateIPv4(v4MappedMatch[1]);
	}

	// Parse first hextet to check ranges numerically
	const firstHextet = parseInt(normalized.split(':')[0], 16);
	if (isNaN(firstHextet)) return true; // malformed → block

	return (
		normalized === '::1' ||
		normalized === '::' ||
		normalized === '0:0:0:0:0:0:0:1' ||
		normalized === '0:0:0:0:0:0:0:0' ||
		(firstHextet >= 0xfe80 && firstHextet <= 0xfebf) || // link-local fe80::/10
		(firstHextet >= 0xfc00 && firstHextet <= 0xfdff) // ULA fc00::/7
	);
}

/**
 * Checks whether an IP address (v4 or v6) is private/internal.
 */
function isPrivateIp(ip: string): boolean {
	if (isIP(ip) === 4) return isPrivateIPv4(ip);
	if (isIP(ip) === 6) return isPrivateIPv6(ip);
	return true; // unknown format → block
}

/**
 * Validates that a URL is safe to fetch (prevents SSRF).
 * Only allows http/https schemes and blocks private/internal network addresses.
 * Resolves both A and AAAA DNS records to verify target IPs are not private.
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

		// Resolve both A (IPv4) and AAAA (IPv6) records
		try {
			const [v4Addrs, v6Addrs] = await Promise.all([
				resolve4(hostname).catch(() => [] as string[]),
				resolve6(hostname).catch(() => [] as string[])
			]);
			const allAddrs = [...v4Addrs, ...v6Addrs];
			if (allAddrs.length === 0) return false;
			return !allAddrs.some((addr) => isPrivateIp(addr));
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
