/**
 * Branded error pages (TASK-54). +error.svelte renders a styled card
 * for 404 and 500 with status-specific copy and a back-to-dashboard
 * CTA. This guards against regressions where someone updates layout
 * code without re-checking error pages.
 */
import { test, expect } from '@playwright/test';

test('404 renders the styled error page', async ({ page }) => {
	const res = await page.goto('/this-route-does-not-exist');
	expect(res?.status()).toBe(404);
	await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
	await expect(page.getByText('404')).toBeVisible();
	// CTA back to dashboard.
	await expect(page.getByRole('link', { name: /Back to dashboard/ })).toHaveAttribute('href', '/');
	// 4xx pages don't show the GitHub-issues footer or the retry button.
	await expect(page.getByRole('button', { name: /Try again/ })).toHaveCount(0);
});

test('error page exposes status and lede in the page title', async ({ page }) => {
	await page.goto('/no-such-route');
	await expect(page).toHaveTitle(/Page not found.*Canvas/);
});
