import { createCanvas, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import sharp from 'sharp';
import type {
	CanvasTemplate,
	FabricObject,
	FabricCanvasJson,
	RenderOptions,
	OutputFormat
} from './types.js';
import { drawWrappedText } from './text.js';
import { loadRemoteImage, loadImagesParallel } from './images.js';
import { initDefaultFonts } from './fonts.js';

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

/**
 * Coerces a string value to the appropriate type for a given property.
 */
function coerceParamValue(prop: string, value: string): string | number {
	if (NUMERIC_PROPS.has(prop)) {
		const num = parseFloat(value);
		return isNaN(num) ? value : num;
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
			const value = params[binding.param] ?? binding.default;
			if (value !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(obj as any)[prop] = coerceParamValue(prop, value);
			}
		}
	}

	return merged;
}

/**
 * Collects all image URLs from template objects that need to be fetched.
 */
function collectImageUrls(objects: FabricObject[]): string[] {
	const urls: string[] = [];
	for (const obj of objects) {
		if ((obj.type === 'image' || obj.type === 'Image') && obj.src) {
			urls.push(obj.src);
		}
	}
	return urls;
}

/**
 * Draws a single Fabric.js object onto a canvas context.
 */
function drawObject(
	ctx: SKRSContext2D,
	obj: FabricObject,
	imageMap: Map<string, Image | null>
): void {
	const left = obj.left ?? 0;
	const top = obj.top ?? 0;
	const scaleX = obj.scaleX ?? 1;
	const scaleY = obj.scaleY ?? 1;
	const angle = obj.angle ?? 0;
	const opacity = obj.opacity ?? 1;
	const width = obj.width ?? 0;
	const height = obj.height ?? 0;

	ctx.save();
	ctx.globalAlpha = opacity;

	// Fabric.js rotates around the object's center by default.
	// To match: translate to center, rotate, translate back, then draw at origin.
	const halfW = (width * scaleX) / 2;
	const halfH = (height * scaleY) / 2;

	ctx.translate(left + halfW, top + halfH);
	if (angle) {
		ctx.rotate((angle * Math.PI) / 180);
	}
	ctx.translate(-halfW, -halfH);
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
 */
function drawImageObject(
	ctx: SKRSContext2D,
	obj: FabricObject,
	imageMap: Map<string, Image | null>
): void {
	if (!obj.src) return;

	const img = imageMap.get(obj.src);
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

	// Ensure fonts are registered
	initDefaultFonts();

	// Merge parameters into template
	const mergedJson = mergeParams(template.templateJson, params);

	// Collect and fetch remote images in parallel
	const imageUrls = collectImageUrls(mergedJson.objects);
	const imageMap = await loadImagesParallel(imageUrls);

	// Create canvas
	const canvas = createCanvas(template.width, template.height);
	const ctx = canvas.getContext('2d');

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
		case 'png':
		default:
			return pipeline.png().toBuffer();
	}
}
