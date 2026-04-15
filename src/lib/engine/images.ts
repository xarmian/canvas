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
 * Validates a URL for SSRF safety and returns a validated IP to connect to.
 * Returns { safe: true, ip } with a validated IP to pin the fetch to,
 * or { safe: false } if the URL is unsafe.
 */
async function validateUrl(url: string): Promise<{ safe: true; ip: string } | { safe: false }> {
	try {
		const parsed = new URL(url);

		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return { safe: false };
		}

		const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

		if (
			hostname === 'localhost' ||
			hostname.endsWith('.local') ||
			hostname.endsWith('.internal') ||
			hostname === 'metadata.google.internal'
		) {
			return { safe: false };
		}

		// If hostname is already an IP, validate and return it directly
		if (isIP(hostname)) {
			return isPrivateIp(hostname) ? { safe: false } : { safe: true, ip: hostname };
		}

		// Resolve both A and AAAA records, pick first safe IP
		const [v4Addrs, v6Addrs] = await Promise.all([
			resolve4(hostname).catch(() => [] as string[]),
			resolve6(hostname).catch(() => [] as string[])
		]);

		// Prefer IPv4 for broader compatibility
		const allAddrs = [...v4Addrs, ...v6Addrs];
		if (allAddrs.length === 0) return { safe: false };

		// ALL resolved IPs must be safe (attacker could have multiple records)
		if (allAddrs.some((addr) => isPrivateIp(addr))) {
			return { safe: false };
		}

		// Return first address to pin the connection to
		return { safe: true, ip: allAddrs[0] };
	} catch {
		return { safe: false };
	}
}

/**
 * Builds a fetch request, pinning to a validated IP for HTTP requests.
 * For HTTPS, we use the original URL because:
 * - IP pinning breaks TLS certificate validation (certs are for domains)
 * - HTTPS is inherently safe from DNS rebinding since TLS verifies the
 *   server certificate matches the requested hostname
 */
function buildPinnedRequest(
	originalUrl: string,
	ip: string,
	signal: AbortSignal
): { url: string; init: RequestInit } {
	const parsed = new URL(originalUrl);

	if (parsed.protocol === 'http:') {
		// HTTP: pin to validated IP, set Host header for virtual hosting
		const originalHost = parsed.host;
		const isV6 = isIP(ip) === 6;
		parsed.hostname = isV6 ? `[${ip}]` : ip;

		return {
			url: parsed.toString(),
			init: {
				signal,
				redirect: 'error' as const,
				headers: { Host: originalHost }
			}
		};
	}

	// HTTPS: use original URL (TLS cert validation prevents rebinding)
	return {
		url: originalUrl,
		init: {
			signal,
			redirect: 'error' as const
		}
	};
}

/**
 * Loads a remote image by URL with timeout and caching.
 * Returns null on failure (timeout, 404, network error, or unsafe URL).
 * Pins fetch to the validated IP to prevent DNS rebinding attacks.
 */
export async function loadRemoteImage(
	url: string,
	timeoutMs: number = 3000
): Promise<Image | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		// Validate URL and get a safe IP to connect to
		const validation = await validateUrl(url);
		if (!validation.safe) return null;

		// Check cache (after validation to avoid serving cached results for unsafe URLs)
		const cached = imageCache.get(url);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			const img = new Image();
			img.src = cached.buffer;
			return img;
		}

		// Fetch pinned to the validated IP to prevent DNS rebinding
		const { url: pinnedUrl, init } = buildPinnedRequest(url, validation.ip, controller.signal);
		const res = await fetch(pinnedUrl, init);
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
			const firstKey = imageCache.keys().next().value;
			if (firstKey) imageCache.delete(firstKey);
		}
		imageCache.set(url, { buffer, timestamp: Date.now() });

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
