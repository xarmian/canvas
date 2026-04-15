import { GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'fs';
import { join } from 'path';

let fontsInitialized = false;

/** Default font families bundled with Canvas */
export const DEFAULT_FONTS = ['Inter', 'sans-serif'] as const;

/**
 * Configurable fonts directory. Defaults to static/fonts/ relative to cwd.
 * Can be overridden via CANVAS_FONTS_DIR environment variable for production
 * builds where the module location differs from the project root.
 */
function getFontsDir(): string {
	return process.env.CANVAS_FONTS_DIR || join(process.cwd(), 'static', 'fonts');
}

/**
 * Registers bundled default fonts with the Skia renderer.
 * Call this once at server startup.
 * Fonts are loaded from the static/fonts/ directory (or CANVAS_FONTS_DIR).
 */
export function initDefaultFonts(): void {
	if (fontsInitialized) return;

	const fontsDir = getFontsDir();

	// Register Inter if available
	const interRegular = join(fontsDir, 'Inter-Regular.ttf');
	const interBold = join(fontsDir, 'Inter-Bold.ttf');

	if (existsSync(interRegular)) {
		GlobalFonts.registerFromPath(interRegular, 'Inter');
	}
	if (existsSync(interBold)) {
		GlobalFonts.registerFromPath(interBold, 'Inter');
	}

	// Try to register system fonts as fallback
	const systemFontPaths = [
		// Linux
		'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
		// macOS
		'/System/Library/Fonts/Helvetica.ttc',
		'/System/Library/Fonts/SFNSText.ttf'
	];

	for (const fontPath of systemFontPaths) {
		if (existsSync(fontPath)) {
			GlobalFonts.registerFromPath(fontPath, 'sans-serif');
			break;
		}
	}

	fontsInitialized = true;
}

/**
 * Registers a custom font from a buffer (e.g., user-uploaded font from S3).
 */
export function registerFontFromBuffer(buffer: Buffer, familyName: string): void {
	GlobalFonts.register(buffer, familyName);
}

/**
 * Registers a custom font from a file path.
 */
export function registerFontFromPath(filePath: string, familyName: string): boolean {
	if (!existsSync(filePath)) return false;
	GlobalFonts.registerFromPath(filePath, familyName);
	return true;
}

/**
 * Returns a list of all registered font family names.
 */
export function getRegisteredFonts(): string[] {
	return GlobalFonts.families.map((f) => f.family);
}
