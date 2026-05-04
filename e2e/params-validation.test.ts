/**
 * canvasParams validation (TASK-52). Schema rows are auto-derived from
 * bindings on save; user marks `required` and `type` via the publish
 * modal; the public render endpoint enforces both, returning a JSON
 * 400 with `field` + `message` on failure.
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

test.describe('Param validation', () => {
	test('required param missing → 400 with field+message', async ({ page }) => {
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Required title', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);

		// Bind text → ?title= (no default), then publish.
		await addTextLayer(page, 'placeholder');
		await bindParam(page, 'Text Content', 'title');
		const { imageUrl } = await publish(page);

		// Mark as required via the publish modal.
		const requiredBox = page.getByRole('checkbox', { name: 'Required title' });
		await expect(requiredBox).toBeVisible({ timeout: 10_000 });
		await requiredBox.check();

		// Wait for the PATCH to settle. Polling the /params endpoint is
		// the deterministic signal — checkbox state is local until the
		// API confirms.
		await expect(async () => {
			const r = await request.get(`/api/canvas/${canvas.id}/params`);
			const rows = (await r.json()) as { name: string; required: boolean }[];
			expect(rows.find((p) => p.name === 'title')?.required).toBe(true);
		}).toPass({ timeout: 5_000 });

		const xff = uniqueXffHeaders();
		// 1. With param → 200 PNG.
		const ok = await request.get(`${imageUrl}?title=Hello`, { headers: xff });
		expect(ok.status()).toBe(200);
		expect(ok.headers()['content-type']).toBe('image/png');

		// 2. Missing required → 400 JSON with field+message.
		const bad = await request.get(imageUrl, { headers: xff });
		expect(bad.status()).toBe(400);
		expect(bad.headers()['content-type']).toContain('application/json');
		const body = (await bad.json()) as { error: string; field: string; message: string };
		expect(body.error).toBe('invalid_param');
		expect(body.field).toBe('title');
		expect(body.message).toMatch(/missing|required/i);
	});

	test('type=number rejects non-numeric → 400', async ({ page }) => {
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Numeric type', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);
		await addTextLayer(page, 'placeholder');
		await bindParam(page, 'Text Content', 'price', '0');
		const { imageUrl } = await publish(page);

		const typeSelect = page.getByLabel('Type for price');
		await expect(typeSelect).toBeVisible({ timeout: 10_000 });
		await typeSelect.selectOption('number');
		await expect(async () => {
			const r = await request.get(`/api/canvas/${canvas.id}/params`);
			const rows = (await r.json()) as { name: string; type: string }[];
			expect(rows.find((p) => p.name === 'price')?.type).toBe('number');
		}).toPass({ timeout: 5_000 });

		const xff = uniqueXffHeaders();
		// Numeric value → 200.
		const ok = await request.get(`${imageUrl}?price=1234.56`, { headers: xff });
		expect(ok.status()).toBe(200);

		// Non-numeric → 400 JSON.
		const bad = await request.get(`${imageUrl}?price=hello`, { headers: xff });
		expect(bad.status()).toBe(400);
		const body = (await bad.json()) as { field: string; message: string };
		expect(body.field).toBe('price');
		expect(body.message).toMatch(/expected a number/i);
	});
});
