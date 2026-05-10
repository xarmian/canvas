import { createCanvas, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import sharp from 'sharp';
import type {
	BadgeIconPosition,
	CanvasTemplate,
	FabricObject,
	FabricCanvasJson,
	RenderOptions,
	OutputFormat
} from './types.js';
import { drawWrappedText } from './text.js';
import { loadRemoteImage, loadImagesParallel } from './images.js';
import { initDefaultFonts } from './fonts.js';
import { applyFormat } from './formatters.js';
import { applyConditionalStyles } from './conditionals.js';
import { coerceBoolean } from './coerce.js';

/** Properties that should remain numeric when bound to URL params */
const NUMERIC_PROPS = new Set([
	'left',
	'top',
	'width',
	'height',
	'scaleX',
	'scaleY',
	'angle',
	'opacity',
	'fontSize',
	'lineHeight'
]);

/** Properties that coerce to booleans. TASK-51 introduces `visible` as the
 * first member; future flags (e.g. drop-shadow on/off) should be added
 * here so the same lenient string→bool parsing applies. */
const BOOLEAN_PROPS = new Set(['visible']);

/**
 * Coerces a string value to the appropriate type for a given property.
 */
function coerceParamValue(prop: string, value: string): string | number | boolean | undefined {
	if (NUMERIC_PROPS.has(prop)) {
		const num = parseFloat(value);
		// Return undefined for invalid numbers so the template default is preserved
		return isNaN(num) ? undefined : num;
	}
	if (BOOLEAN_PROPS.has(prop)) {
		return coerceBoolean(value);
	}
	return value;
}

/**
 * Merges URL parameters into a template's Fabric.js JSON.
 * Replaces bound properties with their parameter values,
 * coercing numeric properties to preserve type safety.
 */
function mergeParams(
	templateJson: FabricCanvasJson,
	params: Record<string, string>
): FabricCanvasJson {
	const merged = JSON.parse(JSON.stringify(templateJson)) as FabricCanvasJson;

	for (const obj of merged.objects) {
		if (!obj.paramBindings) continue;

		for (const [prop, binding] of Object.entries(obj.paramBindings)) {
			const rawValue = params[binding.param] ?? binding.default;
			if (rawValue === undefined) continue;
			// Numeric and boolean properties bypass the formatter — they go
			// straight through coerceParamValue so the binding stays correctly
			// typed on the Fabric object. For text-typed properties (text
			// content, src, fill) we apply the pipe formatter first so the
			// renderer sees the user-facing string.
			const skipFormatter = NUMERIC_PROPS.has(prop) || BOOLEAN_PROPS.has(prop);
			const value = skipFormatter ? rawValue : applyFormat(rawValue, binding.format);
			const coerced = coerceParamValue(prop, value);
			if (coerced !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(obj as any)[prop] = coerced;
			}
		}
	}

	return merged;
}

/**
 * Collects all primary image URLs from template objects that need to be
 * fetched. Skips layers whose `visible` was bound to a falsy URL param —
 * drawObject already short-circuits those, but without this filter the
 * renderer would still pay the network cost of fetching the image (and
 * could issue requests to URLs the user explicitly suppressed).
 *
 * Fallback URLs (TASK-86) are NOT included here — they're fetched lazily
 * by `collectFallbackUrls` only when the primary fails, so a happy-path
 * render doesn't pay for an unused fallback.
 */
function collectImageUrls(objects: FabricObject[]): string[] {
	const seen = new Set<string>();
	for (const obj of objects) {
		if (obj.visible === false) continue;
		if (obj.type === 'image' || obj.type === 'Image') {
			if (obj.src) seen.add(obj.src);
			continue;
		}
		// Badge icons are optional images embedded in the pill (TASK-87).
		// Pre-fetch via the same path so they participate in the LRU /
		// SSRF / asset-preload pipeline.
		if (obj.type === 'badge' || obj.type === 'Badge') {
			if (obj.iconImage) seen.add(obj.iconImage);
		}
	}
	return [...seen];
}

/**
 * Collects fallback URLs to fetch for image layers whose primary `src`
 * failed to load (TASK-86). Run after the first `loadImagesParallel`
 * pass — the imageMap encodes which primaries returned null, and we
 * only attempt a fallback for those layers. Single-level: if the
 * fallback also fails, drawImageObject draws the gray placeholder.
 *
 * Deduped against `imageMap` so a URL already fetched (e.g. another
 * layer's primary) isn't re-fetched. Preloaded URLs (TASK-89) are NOT
 * filtered out — they don't auto-populate `imageMap`; they only land
 * there when explicitly passed to `loadImagesParallel`. Skipping them
 * here would mean a primary failure on a layer with an `asset://`
 * fallback never reaches `imageMap`, leaving `drawImageObject` to draw
 * gray instead of the (already-resolved) fallback bytes.
 */
function collectFallbackUrls(
	objects: FabricObject[],
	imageMap: Map<string, Image | null>
): string[] {
	const seen = new Set<string>();
	for (const obj of objects) {
		if (obj.visible === false) continue;
		if (obj.type !== 'image' && obj.type !== 'Image') continue;
		if (!obj.fallbackSrc) continue;
		// Skip layers whose primary loaded fine, or which had no primary.
		if (!obj.src) continue;
		const primary = imageMap.get(obj.src);
		if (primary) continue;
		// Already attempted via another layer's primary — `loadImagesParallel`
		// would re-fetch (its dedup is per-call), so dedup here.
		if (imageMap.has(obj.fallbackSrc)) continue;
		seen.add(obj.fallbackSrc);
	}
	return [...seen];
}

/**
 * Draws a single Fabric.js object onto a canvas context.
 */
function drawObject(
	ctx: SKRSContext2D,
	obj: FabricObject,
	imageMap: Map<string, Image | null>
): void {
	// `visible: false` skips drawing entirely. Distinct from opacity:0
	// (which still issues fillRect/drawImage and consumes pixels). Default
	// is shown — Fabric only emits `visible` when the user toggled it.
	if (obj.visible === false) return;
	const left = obj.left ?? 0;
	const top = obj.top ?? 0;
	const scaleX = obj.scaleX ?? 1;
	const scaleY = obj.scaleY ?? 1;
	const angle = obj.angle ?? 0;
	const opacity = obj.opacity ?? 1;
	const width = obj.width ?? 0;
	const height = obj.height ?? 0;
	const originX = obj.originX ?? 'left';
	const originY = obj.originY ?? 'top';

	ctx.save();
	ctx.globalAlpha = opacity;

	// Compute origin offset based on Fabric's originX/originY
	const scaledW = width * scaleX;
	const scaledH = height * scaleY;
	const originOffsetX = originX === 'center' ? scaledW / 2 : originX === 'right' ? scaledW : 0;
	const originOffsetY = originY === 'center' ? scaledH / 2 : originY === 'bottom' ? scaledH : 0;

	// Translate to the object's origin point, rotate, then offset to top-left for drawing
	ctx.translate(left, top);
	if (angle) {
		ctx.rotate((angle * Math.PI) / 180);
	}
	ctx.translate(-originOffsetX, -originOffsetY);
	if (scaleX !== 1 || scaleY !== 1) {
		ctx.scale(scaleX, scaleY);
	}

	switch (obj.type) {
		case 'i-text':
		case 'IText':
		case 'textbox':
		case 'Textbox':
		case 'text':
		case 'Text':
			drawTextObject(ctx, obj);
			break;

		case 'image':
		case 'Image':
			drawImageObject(ctx, obj, imageMap);
			break;

		case 'rect':
		case 'Rect':
			drawRectObject(ctx, obj);
			break;

		case 'badge':
		case 'Badge':
			drawBadgeObject(ctx, obj, imageMap);
			break;

		default:
			// Unknown type — skip silently
			break;
	}

	ctx.restore();
}

/**
 * Draws a text object.
 */
function drawTextObject(ctx: SKRSContext2D, obj: FabricObject): void {
	const text = obj.text ?? '';
	const fontSize = obj.fontSize ?? 24;
	const fontFamily = obj.fontFamily ?? 'Inter';
	const fontWeight = obj.fontWeight ?? 'normal';
	const fontStyle = obj.fontStyle ?? 'normal';
	const fill = obj.fill ?? '#000000';
	const textAlign = (obj.textAlign ?? 'left') as CanvasTextAlign;
	const width = obj.width ?? 500;
	const lineHeight = obj.lineHeight ?? 1.2;

	ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
	ctx.fillStyle = fill;

	// Use wrapped text drawing for bounded text
	drawWrappedText(ctx, text, 0, 0, width, fontSize, textAlign, lineHeight);
}

/**
 * Draws an image object.
 *
 * Fallback chain (TASK-86, single-level): primary `src` → `fallbackSrc` →
 * gray placeholder. The fallback is attempted only when the primary failed
 * (collectImageUrls pre-fetched both, so this is a cache lookup, not a
 * second round-trip). Width/height come from the layer's intrinsic
 * dimensions either way so the fallback occupies the same footprint.
 */
function drawImageObject(
	ctx: SKRSContext2D,
	obj: FabricObject,
	imageMap: Map<string, Image | null>
): void {
	if (!obj.src) return;

	let img = imageMap.get(obj.src) ?? null;
	if (!img && obj.fallbackSrc) {
		img = imageMap.get(obj.fallbackSrc) ?? null;
	}

	if (!img) {
		// Draw placeholder rectangle for failed images
		const width = obj.width ?? 100;
		const height = obj.height ?? 100;
		ctx.fillStyle = '#e5e7eb';
		ctx.fillRect(0, 0, width, height);
		return;
	}

	const width = obj.width ?? img.width;
	const height = obj.height ?? img.height;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ctx.drawImage(img as any, 0, 0, width, height);
}

/**
 * Draws a rectangle object.
 */
function drawRectObject(ctx: SKRSContext2D, obj: FabricObject): void {
	const width = obj.width ?? 100;
	const height = obj.height ?? 100;
	const fill = obj.fill ?? '#cccccc';

	ctx.fillStyle = fill;
	ctx.fillRect(0, 0, width, height);
}

/** Default visual constants for the badge primitive (TASK-87). */
const BADGE_DEFAULTS = {
	padding: 10,
	iconGap: 6,
	bg: '#10b981',
	fg: '#ffffff',
	fontSize: 16,
	fontFamily: 'Inter',
	fontWeight: 600,
	iconPosition: 'left' as const
};

/**
 * Draws a badge / pill primitive (TASK-87).
 *
 * Layout: rounded rectangle background sized to (label width + optional
 * icon width + 2*padding + iconGap) × (max(icon, fontSize) + 2*padding).
 * Default radius = height/2 produces a true pill; users can override
 * `radius` for a softer rounded-rect look. Icon position is left/right
 * relative to the label.
 *
 * Auto-sizing means `width`/`height` on the badge layer are advisory —
 * the renderer recomputes them from the content. This matches the editor
 * Badge class and keeps the layout consistent across save/reload (the
 * editor doesn't have to keep stale w/h in sync with label changes).
 *
 * The badge's outer transform (left, top, scale, rotate, opacity) was
 * already applied by `drawObject` before we got here, so we draw at (0,0).
 */
function drawBadgeObject(
	ctx: SKRSContext2D,
	obj: FabricObject,
	imageMap: Map<string, Image | null>
): void {
	const label = obj.label ?? obj.text ?? '';
	const padding = obj.padding ?? BADGE_DEFAULTS.padding;
	const iconGap = label && obj.iconImage ? BADGE_DEFAULTS.iconGap : 0;
	const fontSize = obj.fontSize ?? BADGE_DEFAULTS.fontSize;
	const fontFamily = obj.fontFamily ?? BADGE_DEFAULTS.fontFamily;
	const fontWeight = obj.fontWeight ?? BADGE_DEFAULTS.fontWeight;
	const fontStyle = obj.fontStyle ?? 'normal';
	// `fill` doubles as the bg color so the existing param-binding /
	// conditional pipelines (which target `fill`) drive the pill color
	// without a parallel `bg` plumbing layer.
	const bg = obj.fill ?? obj.bg ?? BADGE_DEFAULTS.bg;
	const fg = obj.fg ?? BADGE_DEFAULTS.fg;
	const iconPosition: BadgeIconPosition = obj.iconPosition ?? BADGE_DEFAULTS.iconPosition;

	ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
	const labelWidth = label ? ctx.measureText(label).width : 0;

	// Resolve icon (asset:// preloads or remote URL) — fallback chain not
	// supported on badge icons (single, optional). Icon size matches the
	// font-derived line height so it visually balances the label.
	const iconUrl = obj.iconImage;
	const iconImg = iconUrl ? (imageMap.get(iconUrl) ?? null) : null;
	const iconRendered = !!iconImg;
	const iconSize = iconRendered ? Math.round(fontSize * 1.1) : 0;

	const innerHeight = Math.max(fontSize, iconSize);
	const totalHeight = innerHeight + padding * 2;
	const totalWidth = labelWidth + (iconRendered ? iconSize + iconGap : 0) + padding * 2;
	const radius = Math.max(0, Math.min(obj.radius ?? totalHeight / 2, totalHeight / 2));

	// Background pill
	ctx.fillStyle = bg;
	if (radius > 0 && typeof ctx.roundRect === 'function') {
		ctx.beginPath();
		ctx.roundRect(0, 0, totalWidth, totalHeight, radius);
		ctx.fill();
	} else {
		ctx.fillRect(0, 0, totalWidth, totalHeight);
	}

	// Layout x positions for icon and label
	let cursorX = padding;
	if (iconRendered && iconPosition === 'left') {
		ctx.drawImage(
			iconImg as unknown as Image,
			cursorX,
			padding + (innerHeight - iconSize) / 2,
			iconSize,
			iconSize
		);
		cursorX += iconSize + iconGap;
	}

	// Label baseline: vertically centered. textBaseline 'middle' lets us
	// position by row center, which is more robust than alphabetic
	// baseline math when the user picks an unfamiliar font.
	if (label) {
		ctx.fillStyle = fg;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		ctx.fillText(label, cursorX, padding + innerHeight / 2);
		cursorX += labelWidth;
	}

	if (iconRendered && iconPosition === 'right') {
		ctx.drawImage(
			iconImg as unknown as Image,
			cursorX + iconGap,
			padding + (innerHeight - iconSize) / 2,
			iconSize,
			iconSize
		);
	}

	// Reset baseline for any subsequent draws (defense in depth — drawObject
	// wraps each layer in save/restore but a future caller might not).
	ctx.textBaseline = 'alphabetic';
}

/**
 * Renders a canvas template with parameters to an image buffer.
 *
 * @param template - The canvas template definition
 * @param params - URL parameters to merge into the template
 * @param options - Output format and quality options
 * @returns Image buffer in the requested format
 */
export async function render(
	template: CanvasTemplate,
	params: Record<string, string> = {},
	options: RenderOptions = {}
): Promise<Buffer> {
	const { format = 'png', quality = 85 } = options;
	// Clamp dpr into [1, 3]. The route layer also clamps before reaching
	// here, but enforcing in the engine keeps any future caller (CLI,
	// background job) safe by default.
	const dpr = Math.max(1, Math.min(3, Math.floor(options.dpr ?? 1)));

	// Ensure fonts are registered
	initDefaultFonts();

	// Merge parameters into template, then apply conditional style rules
	// against the same params (so rules see the URL value, not the
	// post-formatter display string).
	const mergedJson = mergeParams(template.templateJson, params);
	applyConditionalStyles(mergedJson.objects, params);

	// Collect and fetch remote images in parallel. `preloadedImages`
	// (TASK-89) lets the caller inject trusted in-process bytes for
	// owned assets that bypass the SSRF-bounded fetch.
	const imageUrls = collectImageUrls(mergedJson.objects);
	const imageMap = await loadImagesParallel(imageUrls, 3000, options.preloadedImages);

	// TASK-86: fetch fallback URLs only for layers whose primary failed.
	// Done as a second batch (not in parallel with primaries) so a happy-
	// path render with all primaries succeeding pays zero fallback cost.
	// On a cold cache this adds at most one extra round-trip serialized
	// after the primary fetch; subsequent renders hit the LRU cache.
	// `preloadedImages` is forwarded so an owned asset:// fallback resolves
	// from the trusted in-process bytes path — without it, `loadRemoteImage`
	// would block the local-storage URL via the SSRF check.
	const fallbackUrls = collectFallbackUrls(mergedJson.objects, imageMap);
	if (fallbackUrls.length > 0) {
		const fallbackMap = await loadImagesParallel(fallbackUrls, 3000, options.preloadedImages);
		for (const [url, img] of fallbackMap) {
			imageMap.set(url, img);
		}
	}

	// Create canvas at the scaled physical size, then `ctx.scale(dpr, dpr)`
	// so all draw calls use the original logical coordinates. This keeps
	// drawObject + applyConditionalStyles oblivious to dpr.
	const canvas = createCanvas(template.width * dpr, template.height * dpr);
	const ctx = canvas.getContext('2d');
	if (dpr !== 1) ctx.scale(dpr, dpr);

	// Draw background
	if (template.backgroundType === 'color') {
		ctx.fillStyle = template.backgroundValue;
		ctx.fillRect(0, 0, template.width, template.height);
	} else if (template.backgroundType === 'image') {
		const bgImage = await loadRemoteImage(template.backgroundValue);
		if (bgImage) {
			ctx.drawImage(bgImage, 0, 0, template.width, template.height);
		}
	}

	// Draw objects in order (z-index = array order)
	for (const obj of mergedJson.objects) {
		drawObject(ctx, obj, imageMap);
	}

	// Encode via Sharp for optimized output
	const rawBuffer = canvas.toBuffer('image/png');
	return encodeImage(rawBuffer, format, quality);
}

/**
 * Encodes a raw PNG buffer to the requested output format using Sharp.
 */
async function encodeImage(
	pngBuffer: Buffer,
	format: OutputFormat,
	quality: number
): Promise<Buffer> {
	const pipeline = sharp(pngBuffer);

	switch (format) {
		case 'jpeg':
			return pipeline.jpeg({ quality }).toBuffer();
		case 'webp':
			return pipeline.webp({ quality }).toBuffer();
		case 'avif':
			// AVIF: smaller files than WebP at equivalent visual quality.
			// effort:4 is Sharp's default — encode is ~2-4x slower than
			// WebP at the same quality, but worth it for the smaller
			// payload. The render cache amortizes the encode cost.
			return pipeline.avif({ quality }).toBuffer();
		case 'png':
		default:
			return pipeline.png().toBuffer();
	}
}
