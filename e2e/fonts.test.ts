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

		// Wait for the font list to reflect the upload.
		await expect(page.getByText('CanvasTestFont').first()).toBeVisible({ timeout: 10_000 });

		// Open the editor for a fresh canvas, add a text layer, and
		// verify the font dropdown lists the uploaded family.
		await createCanvas(page);
		await addTextLayer(page, 'Brand text');

		// The uploaded family is appended with " (uploaded)" suffix in
		// the dropdown. Assert the option is present.
		const fontSelect = page.locator('#prop-font');
		await expect(fontSelect).toBeVisible();
		await expect(fontSelect.locator('option', { hasText: 'CanvasTestFont' })).toHaveCount(1);

		// Select it and verify the value was applied (Fabric mirrors
		// fontFamily back into the property panel).
		await fontSelect.selectOption('CanvasTestFont');
		await expect(fontSelect).toHaveValue('CanvasTestFont');
	});
});
