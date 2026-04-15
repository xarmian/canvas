import type { SKRSContext2D } from '@napi-rs/canvas';

/**
 * Wraps text into lines that fit within a maximum width.
 * Uses word-by-word wrapping with measureText().
 */
export function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
	if (!text) return [''];

	// Handle explicit newlines as hard line breaks
	if (text.includes('\n')) {
		const hardLines = text.split('\n');
		return hardLines.flatMap((line) => wrapText(ctx, line, maxWidth));
	}

	const words = text.split(' ');
	const lines: string[] = [];
	let currentLine = '';

	for (const word of words) {
		// Break overlong single tokens character-by-character
		if (ctx.measureText(word).width > maxWidth) {
			if (currentLine) {
				lines.push(currentLine);
			}
			let fragment = '';
			for (const char of word) {
				const test = fragment + char;
				if (ctx.measureText(test).width > maxWidth && fragment) {
					lines.push(fragment);
					fragment = char;
				} else {
					fragment = test;
				}
			}
			currentLine = fragment;
			continue;
		}

		const testLine = currentLine ? `${currentLine} ${word}` : word;
		const metrics = ctx.measureText(testLine);

		if (metrics.width > maxWidth && currentLine) {
			lines.push(currentLine);
			currentLine = word;
		} else {
			currentLine = testLine;
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
}

/**
 * Finds the largest font size that fits text within a bounding box.
 * Uses binary search on font size + wrapText() for efficiency.
 */
export function fitText(
	ctx: SKRSContext2D,
	text: string,
	maxWidth: number,
	maxHeight: number,
	fontFamily: string,
	fontWeight: string | number = 'normal',
	fontStyle: string = 'normal',
	minSize: number = 8,
	maxSize: number = 200
): number {
	let lo = minSize;
	let hi = maxSize;

	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		ctx.font = `${fontStyle} ${fontWeight} ${mid}px ${fontFamily}`;

		const lines = wrapText(ctx, text, maxWidth);
		const lineHeight = mid * 1.2;
		const totalHeight = lines.length * lineHeight;

		if (totalHeight <= maxHeight) {
			lo = mid;
		} else {
			hi = mid;
		}
	}

	return lo;
}

/**
 * Draws wrapped text on a canvas context within a bounding box.
 */
export function drawWrappedText(
	ctx: SKRSContext2D,
	text: string,
	x: number,
	y: number,
	maxWidth: number,
	fontSize: number,
	textAlign: CanvasTextAlign = 'left',
	lineHeightMultiplier: number = 1.2
): void {
	const lines = wrapText(ctx, text, maxWidth);
	const lineHeight = fontSize * lineHeightMultiplier;

	ctx.textAlign = textAlign;

	let drawX = x;
	if (textAlign === 'center') {
		drawX = x + maxWidth / 2;
	} else if (textAlign === 'right') {
		drawX = x + maxWidth;
	}

	for (let i = 0; i < lines.length; i++) {
		ctx.fillText(lines[i], drawX, y + fontSize + i * lineHeight);
	}
}
