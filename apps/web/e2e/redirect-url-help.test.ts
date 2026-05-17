/**
 * Redirect URL `{{param}}` substitution help (TASK-96).
 *
 * Inline help, syntax warnings on unknown placeholders, and a live
 * preview showing the substituted URL using each binding's default
 * (or sample) value.
 */
import { test, expect } from '@playwright/test';
import {
	signupAndLogin,
	createCanvas,
	gotoEditor,
	addTextLayer,
	bindParam,
	publish
} from './helpers';

test('valid {{param}} reference shows green affirmation + live preview', async ({ page }) => {
	const request = page.request;
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Redirect valid', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await bindParam(page, 'Text Content', 'tokenA', 'fallback');
	await publish(page);

	const redirectInput = page.getByTestId('redirect-url-input');
	await expect(redirectInput).toBeEnabled();
	await redirectInput.fill('https://app.example.com/lp?token={{tokenA}}');

	// Green affirmation appears.
	await expect(page.getByTestId('redirect-params-ok')).toBeVisible();
	// No unknown-params warning.
	await expect(page.getByTestId('redirect-unknown-params')).toBeHidden();
	// Live preview substitutes the binding default.
	const preview = page.getByTestId('redirect-preview');
	await expect(preview).toBeVisible();
	await expect(preview).toContainText('https://app.example.com/lp?token=fallback');

	// Server still substitutes correctly at redirect time.
	await redirectInput.blur();
	await expect(async () => {
		const r = await request.get(`/api/canvas/${canvas.id}`);
		const data = (await r.json()) as { redirectUrl: string };
		expect(data.redirectUrl).toBe('https://app.example.com/lp?token={{tokenA}}');
	}).toPass({ timeout: 5_000 });
});

test('unknown {{param}} reference shows a red warning listing the unknowns', async ({ page }) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Redirect unknown', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await bindParam(page, 'Text Content', 'realParam');
	await publish(page);

	const redirectInput = page.getByTestId('redirect-url-input');
	await expect(redirectInput).toBeEnabled();
	await redirectInput.fill('https://app.example.com/lp?token={{wrongParam}}');

	const warning = page.getByTestId('redirect-unknown-params');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('wrongParam');
	// Shows the list of available bindings so the user can correct the typo.
	await expect(warning).toContainText('realParam');

	// Green branch should NOT also fire (only one of the two is shown
	// at a time when there are unknowns).
	await expect(page.getByTestId('redirect-params-ok')).toBeHidden();
});

test('mix of known + unknown only shows the warning (warning trumps OK)', async ({ page }) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Redirect mixed', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await bindParam(page, 'Text Content', 'tokenA');
	await publish(page);

	const redirectInput = page.getByTestId('redirect-url-input');
	await expect(redirectInput).toBeEnabled();
	await redirectInput.fill('https://app.example.com/lp?good={{tokenA}}&bad={{nope}}');

	const warning = page.getByTestId('redirect-unknown-params');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('nope');
	await expect(page.getByTestId('redirect-params-ok')).toBeHidden();
});

test('preview updates live as the user types', async ({ page }) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Redirect live', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await bindParam(page, 'Text Content', 'utm', 'twitter');
	await publish(page);

	const redirectInput = page.getByTestId('redirect-url-input');
	const preview = page.getByTestId('redirect-preview');

	await redirectInput.fill('https://x.com/?u={{utm}}');
	await expect(preview).toContainText('https://x.com/?u=twitter');

	await redirectInput.fill('https://x.com/?u={{utm}}&extra=v');
	await expect(preview).toContainText('https://x.com/?u=twitter&extra=v');

	// Preview disappears when there are no placeholders.
	await redirectInput.fill('https://x.com/static');
	await expect(preview).toBeHidden();
});

test('blank redirect URL shows neither warning nor preview', async ({ page }) => {
	await signupAndLogin(page);
	const canvas = await createCanvas(page, { name: 'Redirect blank', preset: 'OG / Twitter' });
	await gotoEditor(page, canvas.id);
	await addTextLayer(page, 'placeholder');
	await publish(page);

	await expect(page.getByTestId('redirect-url-input')).toBeEnabled();
	await expect(page.getByTestId('redirect-params-ok')).toBeHidden();
	await expect(page.getByTestId('redirect-unknown-params')).toBeHidden();
	await expect(page.getByTestId('redirect-preview')).toBeHidden();
});
