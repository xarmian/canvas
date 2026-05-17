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
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer } from './helpers';

test('conditional fill flips on numeric comparison', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Cond fill', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);

	// Constant text — DO NOT bind it to ?change. If we did, different param
	// values would change rendered text bytes regardless of the rule, and
	// the test would pass even with conditional styling never running.
	// Codex caught this in TASK-50 review.
	await addTextLayer(page, 'Constant content');

	// Add rule "when change < 0 then fill = #dc2626" against an unbound
	// param. The collectBoundParams collector now surfaces this in the
	// preview's Test Parameters panel even though it's not a property
	// binding (TASK-50 follow-up).
	await page.getByRole('button', { name: /Conditional Styles/ }).click();
	await page.getByRole('button', { name: '+ Add rule' }).click();
	await page.getByLabel('Rule 1 parameter name').fill('change');
	await page.getByLabel('Rule 1 operator').selectOption('<');
	await page.getByLabel('Rule 1 comparison value').fill('0');
	// fill defaults to red (#dc2626) on rule add — keep it.

	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByTestId('toolbar-save')).toHaveAttribute('data-state', 'saved', {
		timeout: 10_000
	});

	// Verify the rule actually persisted to the templateJson — protects
	// the test from a no-op where save silently dropped conditionalStyles.
	const apiRes = await request.get(`/api/canvas/${canvas.id}`);
	const apiCanvas = (await apiRes.json()) as {
		templateJson: { objects: { conditionalStyles?: unknown[] }[] };
	};
	const obj = apiCanvas.templateJson.objects.find((o) => o.conditionalStyles?.length);
	expect(obj?.conditionalStyles).toHaveLength(1);

	// Render twice: text is constant, so any byte-difference between
	// these two responses MUST come from the conditional fill flipping.
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
