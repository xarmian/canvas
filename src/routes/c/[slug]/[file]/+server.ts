import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases, canvasParams } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { render } from '$lib/engine';
import type { CanvasTemplate, FabricCanvasJson, OutputFormat } from '$lib/engine';
import { validateParams } from '$lib/server/canvas-params';

/** In-memory render cache: URL → { buffer, contentType, timestamp } */
const renderCache = new Map<string, { buffer: Buffer; contentType: string; timestamp: number }>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute
const MAX_CACHE_SIZE = 100;

/** Parse output format from filename */
function parseFormat(file: string): { format: OutputFormat; contentType: string } | null {
	if (file === 'image.png') return { format: 'png', contentType: 'image/png' };
	if (file === 'image.jpg' || file === 'image.jpeg')
		return { format: 'jpeg', contentType: 'image/jpeg' };
	if (file === 'image.webp') return { format: 'webp', contentType: 'image/webp' };
	return null;
}

/** Build a cache key from slug + params + format */
function cacheKey(slug: string, params: Record<string, string>, format: string): string {
	const sortedParams = Object.entries(params)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');
	return `${slug}:${format}:${sortedParams}`;
}

export const GET: RequestHandler = async ({ params, url }) => {
	// Parse format from filename
	const formatInfo = parseFormat(params.file);
	if (!formatInfo) {
		error(404, 'Not found. Use image.png, image.jpg, or image.webp');
	}

	// Load canvas by slug (must be published)
	const [canvas] = await db.select().from(canvases).where(eq(canvases.slug, params.slug));

	if (!canvas || !canvas.published) {
		error(404, 'Canvas not found or not published');
	}

	// Parse URL query parameters
	const queryParams: Record<string, string> = {};
	for (const [key, value] of url.searchParams) {
		queryParams[key] = value;
	}

	// Check render cache
	const key = cacheKey(params.slug, queryParams, formatInfo.format);
	const cached = renderCache.get(key);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return new Response(new Uint8Array(cached.buffer), {
			headers: {
				'Content-Type': cached.contentType,
				'Cache-Control': 'public, max-age=60, s-maxage=300',
				'X-Cache': 'HIT'
			}
		});
	}

	// Load canvas parameter definitions for validation. validateParams
	// also applies defaults for missing optionals, so we no longer need
	// the separate fall-back loop that was here.
	const paramDefs = await db
		.select()
		.from(canvasParams)
		.where(eq(canvasParams.canvasId, canvas.id));

	const validation = validateParams(queryParams, paramDefs);
	if (!validation.ok) {
		// Return a structured JSON 400 — this surface is consumed by API
		// integrators, not browsers. error() would emit text/HTML.
		return new Response(
			JSON.stringify({
				error: 'invalid_param',
				field: validation.field,
				message: validation.reason
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}
	Object.assign(queryParams, validation.resolved);

	// Build template
	const template: CanvasTemplate = {
		width: canvas.width,
		height: canvas.height,
		backgroundType: canvas.backgroundType as 'color' | 'image',
		backgroundValue: canvas.backgroundValue,
		templateJson: (canvas.templateJson as unknown as FabricCanvasJson) ?? { objects: [] }
	};

	// Render
	const buffer = await render(template, queryParams, {
		format: formatInfo.format,
		quality: 85
	});

	// Cache the result
	if (renderCache.size >= MAX_CACHE_SIZE) {
		const firstKey = renderCache.keys().next().value;
		if (firstKey) renderCache.delete(firstKey);
	}
	renderCache.set(key, {
		buffer,
		contentType: formatInfo.contentType,
		timestamp: Date.now()
	});

	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': formatInfo.contentType,
			'Cache-Control': 'public, max-age=60, s-maxage=300',
			'X-Cache': 'MISS'
		}
	});
};
