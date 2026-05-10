/**
 * Template gallery (TASK-64). Verifies /templates renders the curated
 * starters and "Use this template" creates a canvas seeded from the
 * template, navigating to the editor.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin } from './helpers';

test.describe('Template gallery', () => {
	test('shows curated templates and seeds a canvas when one is picked', async ({ page }) => {
		await signupAndLogin(page);

		// Reach /templates via the top nav so we exercise the same path a
		// real user would take on the dashboard.
		await page.getByTestId('nav-templates').click();
		await page.waitForURL('**/templates');
		await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();

		// The curated list ships 10 today (TASK-90 added crypto-lp-card on
		// top of the original 9). Asserted exact rather than a lower bound
		// so accidental drops are caught — additions are a deliberate
		// gallery edit and updating this number alongside is the right
		// friction.
		const cards = page.getByTestId('template-card');
		await expect(cards).toHaveCount(10);

		// Pick the OG card by its data-template-id and click "Use this
		// template". The editor should open with the template's name as
		// the canvas title, proving the template payload was applied.
		const ogCard = page.locator('[data-template-id="og-card"]');
		await expect(ogCard).toBeVisible();
		await ogCard.getByTestId('template-use').click();

		await page.waitForURL(/\/canvas\/[^/]+\/edit$/, { timeout: 10_000 });

		// The editor header shows the canvas name (a `.canvas-name` span);
		// that should match the template's name, proving the seed POST
		// stored templateJson + name correctly.
		await expect(page.locator('.canvas-name')).toHaveText('OG card', { timeout: 5_000 });

		// And the seeded objects (1 rect + 2 textboxes) should appear in
		// the layers list, proving templateJson.objects round-tripped.
		const layers = page.getByRole('listbox', { name: 'Canvas layers' });
		await expect(layers.locator('[role="option"]')).toHaveCount(3);
	});
});
