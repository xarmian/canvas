/**
 * Asset library (TASK-62). Verifies the /assets browse page surfaces
 * uploaded images and the editor's Add Image modal can pick from the
 * library to insert without re-uploading.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addImageLayer, saveAndWait } from './helpers';

/** Smallest legal PNG — 1x1 transparent pixel. Inlined so the test
 *  doesn't need a fixture file on disk. */
const ONE_BY_ONE_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
	'base64'
);

test.describe('Asset library', () => {
	test('uploaded image appears on /assets and can be re-inserted from the library tab', async ({
		page
	}) => {
		await signupAndLogin(page);
		const canvas = await createCanvas(page);

		// Upload an image via the editor toolbar (which now opens the Add
		// Image modal). The helper drives the modal's hidden file input.
		await addImageLayer(page, {
			name: 'test-asset.png',
			mimeType: 'image/png',
			buffer: ONE_BY_ONE_PNG
		});

		// Saves are manual since BT-160 — click Save and wait for the
		// toolbar Save button to settle on the 'saved' state so the
		// editor's beforeNavigate guard doesn't trap us in the
		// Leave-without-saving dialog when we navigate away.
		await saveAndWait(page);

		// Navigate to the assets page via the top nav and verify the asset
		// is listed there.
		await page.getByTestId('nav-assets').click();
		await page.waitForURL('**/assets');
		await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
		// The card surfaces filename in a title attribute and visible text
		// container; the visible text container is the stable target.
		await expect(page.locator('.filename', { hasText: 'test-asset.png' })).toBeVisible();

		// Go back to the editor and open the Add Image modal again, this
		// time using the From-library tab to insert the same asset without
		// re-uploading.
		await gotoEditor(page, canvas.id);
		await page.getByTestId('toolbar-add-image').click();

		// Switch to the From-library tab. Match the visible label by
		// regex so the count suffix doesn't break the matcher.
		await page.getByRole('tab', { name: /^From library/ }).click();

		// Snapshot layer count, click the library tile, wait for the new
		// layer to appear.
		const layerList = page.getByRole('listbox', { name: 'Canvas layers' });
		const before = await layerList.locator('[role="option"]').count();
		await page.getByTestId('add-image-library-tile').first().click();
		await expect(async () => {
			const after = await layerList.locator('[role="option"]').count();
			expect(after).toBe(before + 1);
		}).toPass({ timeout: 10_000 });
	});

	test('deleting an asset from /assets warns when it is in use', async ({ page }) => {
		await signupAndLogin(page);
		const canvas = await createCanvas(page);

		await addImageLayer(page, {
			name: 'usage-warn.png',
			mimeType: 'image/png',
			buffer: ONE_BY_ONE_PNG
		});

		// Saves are manual since BT-160 — persist explicitly so the
		// templateJson actually contains the asset URL by the time the
		// usage scan runs.
		await saveAndWait(page);

		await page.goto('/assets');
		await page.waitForLoadState('networkidle');

		// Click Delete on the asset, confirm dialog should mention the canvas.
		await page.getByRole('button', { name: 'Delete usage-warn.png' }).click();
		// Wait for usage scan to complete (loading state -> resolved state).
		const dialog = page.getByRole('dialog');
		await expect(dialog).toContainText(canvas.name, { timeout: 5_000 });
		await expect(dialog).toContainText('canvas', { ignoreCase: true });

		// Cancel — we just verified the warning surface.
		await page.getByRole('button', { name: 'Cancel' }).click();
	});
});
