/**
 * Smoke test for e2e/helpers — drives the full happy path through every
 * helper exported from helpers/index.ts. If this passes, the building
 * blocks are healthy enough for the v0.3 spec files (TASK-45..48).
 */
import { test, expect } from '@playwright/test';
import {
	signupAndLogin,
	createCanvas,
	gotoEditor,
	addTextLayer,
	addImageLayer,
	bindParam,
	publish,
	copyShareUrl
} from './helpers';

// Minimal valid 1x1 transparent PNG — keeps tests offline & deterministic
// (no network image fetch). Inline bytes so we don't ship a binary fixture.
const TINY_PNG = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
		'0000000d49444154789c6300010000050001' +
		'0d0a2db40000000049454e44ae426082',
	'hex'
);

test('helpers — signup → create → edit → publish → share URL', async ({ page }) => {
	// ---- signupAndLogin
	const creds = await signupAndLogin(page);
	expect(creds.email).toMatch(/@test\.com$/);

	// ---- createCanvas + gotoEditor (round-trip via id)
	const canvas = await createCanvas(page, { name: 'Helpers Smoke', preset: 'OG / Twitter' });
	expect(canvas.id).toBeTruthy();
	expect(canvas.name).toBe('Helpers Smoke');
	await gotoEditor(page, canvas.id);

	// ---- addTextLayer
	await addTextLayer(page, 'Hello {{title}}');

	// ---- addImageLayer (PNG via the toolbar's file input)
	await addImageLayer(page, {
		name: 'pixel.png',
		mimeType: 'image/png',
		buffer: TINY_PNG
	});

	// ---- bindParam (the text layer's content was the last selection;
	// we re-select something to ensure a known target). The text layer
	// was selected on add; the image upload may have reset selection,
	// so explicitly add another text layer for a deterministic target.
	await addTextLayer(page, 'Subtitle');
	await bindParam(page, 'Text Content', 'subtitle', 'Default subtitle');

	// ---- publish + copyShareUrl
	const { shareUrl, imageUrl } = await publish(page);
	// Slug is lowercase-name + nanoid suffix which can include any alphanumeric.
	expect(shareUrl).toMatch(/\/c\/[A-Za-z0-9-]+$/);
	expect(imageUrl).toMatch(/\/c\/[A-Za-z0-9-]+\/image\.png$/);

	// copyShareUrl re-reads from the still-open modal. Distinct from
	// publish() so callers can assert again without re-publishing.
	const shareUrlAgain = await copyShareUrl(page);
	expect(shareUrlAgain).toBe(shareUrl);
});
