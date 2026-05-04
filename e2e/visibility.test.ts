/**
 * Layer visibility binding — bind `visible` to ?show, then assert that
 * ?show=true and ?show=false produce different rendered bytes (the
 * latter omits the layer entirely).
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer, bindParam } from './helpers';

test('visibility binding hides the layer when param is false', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Visibility', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);

	// Add a layer that will sometimes be hidden. Keep the text constant so
	// any byte-difference between renders is the visibility toggle, not
	// text content.
	await addTextLayer(page, 'Maybe shown');
	await bindParam(page, 'Visibility', 'show', 'true');

	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });

	const visible = await request.get(`/api/canvas/${canvas.id}/preview?show=true`);
	const hidden = await request.get(`/api/canvas/${canvas.id}/preview?show=false`);
	expect(visible.status()).toBe(200);
	expect(hidden.status()).toBe(200);
	const visBody = await visible.body();
	const hidBody = await hidden.body();
	expect(visBody.length).toBeGreaterThan(100);
	expect(hidBody.length).toBeGreaterThan(100);
	expect(visBody.equals(hidBody)).toBe(false);

	// Every accepted truthy/falsy spelling produces consistent output.
	for (const truthy of ['1', 'yes', 'on']) {
		const r = await request.get(`/api/canvas/${canvas.id}/preview?show=${truthy}`);
		expect((await r.body()).equals(visBody)).toBe(true);
	}
	for (const falsy of ['0', 'no', 'off']) {
		const r = await request.get(`/api/canvas/${canvas.id}/preview?show=${falsy}`);
		expect((await r.body()).equals(hidBody)).toBe(true);
	}
});
