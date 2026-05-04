/**
 * Dashboard organization (TASK-66). Verifies folder + tag editing,
 * sidebar folder filtering, and search box filtering against a
 * 3-canvas seed.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas } from './helpers';

test.describe('Dashboard organization', () => {
	test('user can assign folders + tags and filter the dashboard', async ({ page }) => {
		await signupAndLogin(page);

		// Three canvases — Alpha will land in folder "Marketing" with tag
		// "promo". Beta will land in folder "Marketing" untagged. Gamma
		// stays uncategorized so we can prove the Uncategorized bucket
		// counts NULL folders.
		await createCanvas(page, { name: 'Alpha' });
		await page.getByTestId('nav-dashboard').click();
		await page.waitForURL('/');

		await createCanvas(page, { name: 'Beta' });
		await page.getByTestId('nav-dashboard').click();
		await page.waitForURL('/');

		await createCanvas(page, { name: 'Gamma' });
		await page.getByTestId('nav-dashboard').click();
		await page.waitForURL('/');

		// Three cards on the dashboard.
		await expect(page.locator('[data-testid="canvas-card"]')).toHaveCount(3);

		// Open Organize on Alpha and set folder + tag.
		const alphaCard = page.locator('[data-canvas-name="Alpha"]');
		await alphaCard.getByTestId('card-organize').click();
		await page.getByTestId('org-folder').fill('Marketing');
		await page.getByTestId('org-tag-input').fill('promo');
		await page.getByTestId('org-tag-input').press('Enter');
		await page.getByTestId('org-save').click();

		// Modal closes; Alpha card now shows the folder badge + tag chip.
		await expect(alphaCard.getByText('Marketing')).toBeVisible();
		await expect(alphaCard.getByText('#promo')).toBeVisible();

		// Same flow for Beta — same folder, no tag.
		const betaCard = page.locator('[data-canvas-name="Beta"]');
		await betaCard.getByTestId('card-organize').click();
		await page.getByTestId('org-folder').fill('Marketing');
		await page.getByTestId('org-save').click();
		await expect(betaCard.getByText('Marketing')).toBeVisible();

		// Sidebar should now have a Marketing folder with count 2.
		const marketingFolder = page.getByTestId('folder-Marketing');
		await expect(marketingFolder).toBeVisible();
		await expect(marketingFolder).toContainText('2');

		// Filter by Marketing — only Alpha + Beta should be visible.
		await marketingFolder.click();
		await expect(page.locator('[data-testid="canvas-card"]')).toHaveCount(2);
		await expect(page.locator('[data-canvas-name="Alpha"]')).toBeVisible();
		await expect(page.locator('[data-canvas-name="Beta"]')).toBeVisible();
		await expect(page.locator('[data-canvas-name="Gamma"]')).not.toBeVisible();

		// Click All to reset, then filter by Uncategorized.
		await page.getByTestId('folder-all').click();
		await expect(page.locator('[data-testid="canvas-card"]')).toHaveCount(3);
		await page.getByTestId('folder-uncategorized').click();
		await expect(page.locator('[data-testid="canvas-card"]')).toHaveCount(1);
		await expect(page.locator('[data-canvas-name="Gamma"]')).toBeVisible();

		// Reset filter, then search by name.
		await page.getByTestId('folder-all').click();
		await page.getByTestId('dashboard-search').fill('alpha');
		await expect(page.locator('[data-testid="canvas-card"]')).toHaveCount(1);
		await expect(page.locator('[data-canvas-name="Alpha"]')).toBeVisible();

		// Search by tag — clear the box, then search "promo".
		await page.getByTestId('dashboard-search').fill('promo');
		await expect(page.locator('[data-testid="canvas-card"]')).toHaveCount(1);
		await expect(page.locator('[data-canvas-name="Alpha"]')).toBeVisible();

		// Clear search, then click the tag chip on Alpha to filter by it.
		await page.getByTestId('dashboard-search').fill('');
		await page.locator('[data-canvas-name="Alpha"]').getByTestId('tag-chip').click();
		await expect(page.locator('[data-testid="canvas-card"]')).toHaveCount(1);
		await expect(page.locator('[data-canvas-name="Alpha"]')).toBeVisible();
	});
});
