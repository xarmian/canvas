/**
 * Canvas duplication (TASK-65). Verifies POST /api/canvas/[id]/duplicate
 * via the dashboard "Duplicate" button: clones content, regenerates the
 * slug, starts as a draft, and lands the user in the new canvas's editor.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, addTextLayer, saveAndWait } from './helpers';

test.describe('Canvas duplication', () => {
	test('dashboard Duplicate clones the canvas as a draft and opens the new editor', async ({
		page
	}) => {
		await signupAndLogin(page);
		const original = await createCanvas(page, { name: 'Original Canvas' });
		// Add a text layer so we have something to verify round-trips.
		await addTextLayer(page, 'Hello duplicate');
		// Saves are manual since BT-160 — click Save explicitly so
		// beforeNavigate doesn't block us when we leave the editor.
		await saveAndWait(page);

		// Back to dashboard, then click Duplicate on the original card.
		await page.getByTestId('nav-dashboard').click();
		await page.waitForURL('/dashboard');
		const card = page.locator('.card').filter({ hasText: 'Original Canvas' });
		await expect(card).toBeVisible();
		await card.getByTestId('card-duplicate').click();

		// Should land in the new canvas's editor — different id, "(copy)" suffix.
		await page.waitForURL(/\/canvas\/[^/]+\/edit$/, { timeout: 10_000 });
		const newId = page.url().match(/\/canvas\/([^/]+)\/edit$/)?.[1];
		expect(newId).toBeTruthy();
		expect(newId).not.toBe(original.id);

		await expect(page.locator('.canvas-name')).toHaveText('Original Canvas (copy)');

		// Layers list should show the cloned text layer.
		const layers = page.getByRole('listbox', { name: 'Canvas layers' });
		await expect(layers.locator('[role="option"]')).toHaveCount(1);

		// Back to dashboard — both canvases should now exist, and the copy
		// is a Draft (publish state is intentionally not copied). Fabric's
		// hydrate of a freshly-duplicated canvas can trigger an initial
		// dirty cycle, so explicitly save before navigating to keep
		// beforeNavigate from trapping us in the leave-without-saving
		// dialog (saves are manual since BT-160).
		await saveAndWait(page);
		await page.getByTestId('nav-dashboard').click();
		await page.waitForURL('/dashboard');
		const copyCard = page.locator('.card').filter({ hasText: 'Original Canvas (copy)' });
		await expect(copyCard).toBeVisible();
		await expect(copyCard.getByText('Draft')).toBeVisible();
		// Two cards total: the original + the copy. filter({hasText}) is a
		// substring match, so we count cards instead of trying to anchor
		// "Original Canvas" exactly (the dashboard card text includes
		// dimensions/badge/edited-time, which would break a regex anchor).
		await expect(page.locator('.card')).toHaveCount(2);
	});
});
