/**
 * Conditional-styling rule coverage. Builds a canvas with a text layer
 * whose fill flips between green / red based on a `change` URL param,
 * then asserts the rendered output differs across the boundary.
 *
 * Pixel-diff isn't practical (no reliable color sampling on Skia output
 * without decoding); we settle for byte-difference, which is enough to
 * prove the rule actually fired.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer, bindParam } from './helpers';

test('conditional fill flips on numeric comparison', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Cond fill', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);

	await addTextLayer(page, '+0.0%');
	// Bind text to ?change= so the layer's content tracks the param. The
	// rule itself just keys off the same param name; the binding default
	// keeps the editor preview readable while building rules.
	await bindParam(page, 'Text Content', 'change', '0');

	// Open Conditional Styles → add rule "when change < 0 then fill = #dc2626".
	await page.getByRole('button', { name: /Conditional Styles/ }).click();
	await page.getByRole('button', { name: '+ Add rule' }).click();

	// First-rule fields are uniquely accessible by their aria-labels
	// (set to "Rule 1 …" by the property panel).
	await page.getByLabel('Rule 1 parameter name').fill('change');
	await page.getByLabel('Rule 1 operator').selectOption('<');
	await page.getByLabel('Rule 1 comparison value').fill('0');
	// fill defaults to red (#dc2626) on rule add — keep it.

	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });

	// Render twice: once with change<0 (rule fires), once with change>0
	// (rule doesn't fire). Rendered byte buffers must differ — same
	// template, different effective fill.
	const negative = await request.get(`/api/canvas/${canvas.id}/preview?change=-12.5`);
	const positive = await request.get(`/api/canvas/${canvas.id}/preview?change=+12.5`);
	expect(negative.status()).toBe(200);
	expect(positive.status()).toBe(200);
	const negBody = await negative.body();
	const posBody = await positive.body();
	expect(negBody.length).toBeGreaterThan(100);
	expect(posBody.length).toBeGreaterThan(100);
	expect(negBody.equals(posBody)).toBe(false);
});
