/**
 * Parameter binding round-trip — bind a text layer's content to ?title=,
 * publish, then verify the public render endpoint honors the param and
 * falls back to the binding default when omitted.
 */
import { test, expect } from '@playwright/test';
import {
	signupAndLogin,
	createCanvas,
	gotoEditor,
	addTextLayer,
	bindParam,
	publish,
	uniqueXffHeaders
} from './helpers';

test('parameter binding round-trips editor → render', async ({ page, request }) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Binding RT', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);

	// Add a text layer, bind its content to ?title= with default 'Hello'.
	await addTextLayer(page, 'Original content');
	await bindParam(page, 'Text Content', 'title', 'Hello');

	// Publish + capture the slug-bearing image URL the modal exposes.
	const { imageUrl } = await publish(page);
	expect(imageUrl).toMatch(/\/c\/[A-Za-z0-9-]+\/image\.png$/);

	// Unique XFF so this test's per-IP rate limit bucket (TASK-72) is
	// isolated from sibling tests'.
	const headers = uniqueXffHeaders();

	// --- 1. Custom param value should be served back as PNG.
	const customRes = await request.get(`${imageUrl}?title=Custom`, { headers });
	expect(customRes.status()).toBe(200);
	expect(customRes.headers()['content-type']).toBe('image/png');
	const customBody = await customRes.body();
	expect(customBody.length).toBeGreaterThan(100);

	// --- 2. Omitting the param should still render (binding default kicks in).
	const defaultRes = await request.get(imageUrl, { headers });
	expect(defaultRes.status()).toBe(200);
	expect(defaultRes.headers()['content-type']).toBe('image/png');
	const defaultBody = await defaultRes.body();
	expect(defaultBody.length).toBeGreaterThan(100);

	// The two renders should differ — same template, different effective text.
	// (Pixel-equality would be brittle across renderer changes; byte-length is
	// a coarse but stable signal that the parameter actually changed output.)
	expect(customBody.equals(defaultBody)).toBe(false);
});
