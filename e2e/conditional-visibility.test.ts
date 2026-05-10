/**
 * Conditional `visible` rule coverage (TASK-85).
 *
 * Two angles:
 *   1. A rule targeting `visible` actually flips a layer's render.
 *   2. When the same property is BOTH bound to a URL param AND targeted by
 *      a conditional rule, the conditional wins (last-write-wins, applied
 *      after parameter substitution in render()).
 *
 * Same byte-difference assertion strategy as e2e/conditionals.test.ts —
 * pixel-diffing isn't reliable on Skia output, but byte equality across
 * fixed inputs proves which override fired.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer, bindParam } from './helpers';

test('conditional rule hides a layer when condition matches', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Cond visibility', preset: 'OG Image' });
	await gotoEditor(page, canvas.id);

	// Constant text — DO NOT bind it. Same rationale as e2e/conditionals.test.ts:
	// if the text changed across renders, byte-diff would no longer prove
	// the visibility rule fired.
	await addTextLayer(page, 'Hide me sometimes');

	// Add rule: when range == 'out_of_range' then visible = false.
	await page.getByRole('button', { name: /Conditional Styles/ }).click();
	await page.getByRole('button', { name: '+ Add rule' }).click();
	await page.getByLabel('Rule 1 parameter name').fill('range');
	await page.getByLabel('Rule 1 operator').selectOption('==');
	await page.getByLabel('Rule 1 comparison value').fill('out_of_range');
	await page.getByLabel('Rule 1 property to override').selectOption('visible');
	// `visible` defaults to 'false' (hidden) per conditionalPropertyDefaults
	// in PropertyPanel.svelte — protects against a stale color/opacity value
	// leaking in when the user changes the property dropdown.
	await expect(page.getByLabel('Rule 1 visibility')).toHaveValue('false');

	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });

	// Verify the rule actually persisted to the templateJson — protects
	// against a no-op where save silently dropped the new property type.
	const apiRes = await request.get(`/api/canvas/${canvas.id}`);
	const apiCanvas = (await apiRes.json()) as {
		templateJson: {
			objects: Array<{
				conditionalStyles?: Array<{ then?: { property?: string; value?: string } }>;
			}>;
		};
	};
	const obj = apiCanvas.templateJson.objects.find((o) => o.conditionalStyles?.length);
	expect(obj?.conditionalStyles?.[0]?.then?.property).toBe('visible');
	expect(obj?.conditionalStyles?.[0]?.then?.value).toBe('false');

	// range=in_range → no match → layer visible.
	// range=out_of_range → match → layer hidden.
	const visible = await request.get(`/api/canvas/${canvas.id}/preview?range=in_range`);
	const hidden = await request.get(`/api/canvas/${canvas.id}/preview?range=out_of_range`);
	expect(visible.status()).toBe(200);
	expect(hidden.status()).toBe(200);
	const visBody = await visible.body();
	const hidBody = await hidden.body();
	expect(visBody.length).toBeGreaterThan(100);
	expect(hidBody.length).toBeGreaterThan(100);
	expect(visBody.equals(hidBody)).toBe(false);
});

test('conditional rule wins over a visible binding (precedence)', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, {
		name: 'Cond vis precedence',
		preset: 'OG Image'
	});
	await gotoEditor(page, canvas.id);

	// Layer with `visible` bound to ?show defaulting to true.
	await addTextLayer(page, 'Layer with both');
	await bindParam(page, 'Visibility', 'show', 'true');

	// Add rule on the same layer: when ?hide == 'true' then visible = false.
	// applyConditionalStyles runs AFTER mergeParams in render(), so the rule
	// must override the binding when both fire — that is the precedence
	// contract documented on ConditionalProperty.
	await page.getByRole('button', { name: /Conditional Styles/ }).click();
	await page.getByRole('button', { name: '+ Add rule' }).click();
	await page.getByLabel('Rule 1 parameter name').fill('hide');
	await page.getByLabel('Rule 1 operator').selectOption('==');
	await page.getByLabel('Rule 1 comparison value').fill('true');
	await page.getByLabel('Rule 1 property to override').selectOption('visible');
	// Default 'false' value — leave as-is.

	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });

	// ?show=true alone → no rule match → layer visible (binding wins, no conflict).
	const visible = await request.get(`/api/canvas/${canvas.id}/preview?show=true`);
	// ?show=true&hide=true → rule fires → layer hidden (conditional wins).
	const hiddenByRule = await request.get(`/api/canvas/${canvas.id}/preview?show=true&hide=true`);
	expect(visible.status()).toBe(200);
	expect(hiddenByRule.status()).toBe(200);
	const visBody = await visible.body();
	const hidBody = await hiddenByRule.body();
	expect(visBody.length).toBeGreaterThan(100);
	expect(hidBody.length).toBeGreaterThan(100);
	expect(visBody.equals(hidBody)).toBe(false);

	// Sanity: ?show=true&hide=false → no rule match → byte-identical to
	// the show=true baseline. If this fails, the rule is firing on
	// something other than the explicit 'true' value.
	const noRuleMatch = await request.get(`/api/canvas/${canvas.id}/preview?show=true&hide=false`);
	expect((await noRuleMatch.body()).equals(visBody)).toBe(true);
});
