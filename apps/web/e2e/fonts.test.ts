/**
 * Custom font upload + editor font picker (TASK-63). Verifies the
 * Fonts tab on /assets accepts uploads and the editor's font picker
 * surfaces uploaded families.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, addTextLayer } from './helpers';

// Reuse the bundled Inter-Regular as a real TTF the test can upload.
// We rename it to a distinct family so its appearance in the picker
// (vs. the always-present "Inter" bundled entry) is unambiguous.
const interRegular = readFileSync(join(process.cwd(), 'static/fonts/Inter-Regular.ttf'));

test.describe('Custom fonts', () => {
	test('font upload appears in /assets Fonts tab and editor font picker', async ({ page }) => {
		await signupAndLogin(page);

		// Navigate to /assets, switch to Fonts tab, upload a TTF.
		await page.goto('/assets');
		await page.waitForLoadState('networkidle');
		await page.getByTestId('assets-tab-fonts').click();

		// The hidden font input is a sibling of the Fonts tab pane.
		const fontInput = page.locator('input[type="file"][accept*=".ttf"]');
		await expect(fontInput).toHaveCount(1);
		await fontInput.setInputFiles({
			name: 'CanvasTestFont.ttf',
			mimeType: 'font/ttf',
			buffer: interRegular
		});

		// Wait for the font row to actually appear in the list. Matching
		// `getByText('CanvasTestFont')` is fragile — the upload toast
		// transiently contains the same text, which would let the test
		// proceed before the upload+listing round-trip finished and
		// then race the navigation that follows.
		await expect(page.locator('.font-family', { hasText: 'CanvasTestFont' })).toBeVisible({
			timeout: 15_000
		});

		// Open the editor for a fresh canvas, add a text layer, and
		// verify the font dropdown lists the uploaded family.
		await createCanvas(page);
		await addTextLayer(page, 'Brand text');

		// The uploaded family is appended with " (uploaded)" suffix in
		// the dropdown. Assert the option is present.
		const fontSelect = page.locator('#prop-font');
		await expect(fontSelect).toBeVisible();
		const userOption = fontSelect.locator('option', { hasText: 'CanvasTestFont' });
		await expect(userOption).toHaveCount(1);

		// The option's value is the userId-namespaced family (e.g.
		// u-<id>__CanvasTestFont) so two users uploading the same
		// filename can't collide in the server-side GlobalFonts
		// registry. Select by label so the test doesn't depend on
		// the namespace shape.
		const value = await userOption.getAttribute('value');
		expect(value).toBeTruthy();
		await fontSelect.selectOption({ value: value! });
		await expect(fontSelect).toHaveValue(value!);
	});
});
