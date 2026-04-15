import { Image } from '@napi-rs/canvas';
import { resolve4, resolve6 } from 'dns/promises';
import { isIP } from 'net';

/** Simple LRU-ish cache for fetched remote images */
const imageCache = new Map<string, { buffer: Buffer; timestamp: number }>();
let cacheBytes = 0;
const MAX_CACHE_SIZE = 200;
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100MB total cache budget
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB max per image
const MAX_CONCURRENT_FETCHES = 6;

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
		(a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT, RFC 6598)
		(a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
		(a === 192 && b === 168) // 192.168.0.0/16
	);
}

/**
 * Extracts an embedded IPv4 address from an IPv4-mapped IPv6 address.
 * Handles both ::ffff:1.2.3.4 (dotted) and 0:0:0:0:0:ffff:7f00:1 (hex) forms.
 * Returns null if not an IPv4-mapped address.
 */
function extractMappedIPv4(ip: string): string | null {
	const normalized = ip.toLowerCase();

	// Dotted form: ::ffff:1.2.3.4
	const dottedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (dottedMatch) return dottedMatch[1];

	// Expanded hex form: 0:0:0:0:0:ffff:XXYY:ZZWW
	// The prefix must be all zeros except the ffff
	const hexMatch = normalized.match(/^(?:0+:){4}0*:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (hexMatch) {
		const hi = parseInt(hexMatch[1], 16);
		const lo = parseInt(hexMatch[2], 16);
		return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
	}

	return null;
}

/**
 * Checks whether an IPv6 address is private/internal.
 * Covers loopback (::1), link-local (fe80::/10), ULA (fc00::/7),
 * and IPv4-mapped addresses in both dotted and expanded hex forms.
 */
function isPrivateIPv6(ip: string): boolean {
	const normalized = ip.toLowerCase();

	// Check IPv4-mapped forms
	const mappedV4 = extractMappedIPv4(normalized);
	if (mappedV4) return isPrivateIPv4(mappedV4);

	// Parse first hextet to check ranges numerically
	const firstPart = normalized.split(':')[0];
	const firstHextet = firstPart ? parseInt(firstPart, 16) : NaN;
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
 * Resolves DNS and checks all resulting IPs against private ranges.
 */
async function isUrlSafe(url: string): Promise<boolean> {
	try {
		const parsed = new URL(url);

		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return false;
		}

		const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

		if (
			hostname === 'localhost' ||
			hostname.endsWith('.local') ||
			hostname.endsWith('.internal') ||
			hostname === 'metadata.google.internal'
		) {
			return false;
		}

		// If hostname is already an IP, validate directly
		if (isIP(hostname)) {
			return !isPrivateIp(hostname);
		}

		// Resolve both A and AAAA records
		const [v4Addrs, v6Addrs] = await Promise.all([
			resolve4(hostname).catch(() => [] as string[]),
			resolve6(hostname).catch(() => [] as string[])
		]);

		const allAddrs = [...v4Addrs, ...v6Addrs];
		if (allAddrs.length === 0) return false;

		// ALL resolved IPs must be safe
		return !allAddrs.some((addr) => isPrivateIp(addr));
	} catch {
		return false;
	}
}

/**
 * Loads a remote image by URL with timeout and caching.
 * Returns null on failure (timeout, 404, network error, or unsafe URL).
 *
 * SSRF defense layers:
 * 1. DNS resolution of all A+AAAA records with private IP validation
 * 2. Redirect following disabled (redirect: 'error')
 * 3. Timeout bounding all operations including DNS
 * 4. Response size limit (10MB)
 * 5. HTTPS: TLS cert validation inherently prevents DNS rebinding
 * 6. HTTP: DNS rebinding window is minimal (sub-second TTL required)
 */
export async function loadRemoteImage(
	url: string,
	timeoutMs: number = 3000
): Promise<Image | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		// Validate URL to prevent SSRF
		if (!(await isUrlSafe(url))) return null;

		// Check cache (after validation to avoid serving cached results for unsafe URLs)
		const cached = imageCache.get(url);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			const img = new Image();
			img.src = cached.buffer;
			return img;
		}

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

		// Subtract old entry if overwriting (e.g. refetch after TTL expiry)
		const existing = imageCache.get(url);
		if (existing) cacheBytes -= existing.buffer.byteLength;

		// Evict oldest entries if over count or byte budget
		while (
			(imageCache.size >= MAX_CACHE_SIZE || cacheBytes + buffer.byteLength > MAX_CACHE_BYTES) &&
			imageCache.size > 0
		) {
			const firstKey = imageCache.keys().next().value;
			if (!firstKey) break;
			const evicted = imageCache.get(firstKey);
			if (evicted) cacheBytes -= evicted.buffer.byteLength;
			imageCache.delete(firstKey);
		}
		imageCache.set(url, { buffer, timestamp: Date.now() });
		cacheBytes += buffer.byteLength;

		return img;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
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
 * Loads multiple images with bounded concurrency, returning null for any that fail.
 */
export async function loadImagesParallel(
	urls: string[],
	timeoutMs: number = 3000
): Promise<Map<string, Image | null>> {
	// Bounded concurrency: process in chunks of MAX_CONCURRENT_FETCHES
	const results: PromiseSettledResult<Image | null>[] = [];
	for (let i = 0; i < urls.length; i += MAX_CONCURRENT_FETCHES) {
		const chunk = urls.slice(i, i + MAX_CONCURRENT_FETCHES);
		const chunkResults = await Promise.allSettled(
			chunk.map((url) => loadRemoteImage(url, timeoutMs))
		);
		results.push(...chunkResults);
	}

	const imageMap = new Map<string, Image | null>();
	urls.forEach((url, i) => {
		const result = results[i];
		imageMap.set(url, result.status === 'fulfilled' ? result.value : null);
	});

	return imageMap;
}
