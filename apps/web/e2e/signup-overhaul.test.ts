/**
 * Signup UX overhaul (TASK-56). Inline hints, friendly duplicate-email
 * mapping with a "Log in instead" CTA, password length feedback.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, uniqueEmail } from './helpers';

test.describe('Signup UX', () => {
	test('inline hints appear after first submit and clear on valid input', async ({ page }) => {
		await page.goto('/signup');
		await page.waitForLoadState('networkidle');

		// Submit empty → inline hints appear, no native browser popover
		// (we set novalidate on the form so the JS-driven hints take over).
		await page.getByRole('button', { name: 'Sign up' }).click();
		await expect(page.getByText('Enter your email address.')).toBeVisible();
		await expect(page.getByText(`At least 8 characters.`)).toBeVisible();

		// Type a malformed email → switches to the format-error hint.
		await page.getByLabel('Email').fill('not-an-email');
		await expect(page.getByText("That doesn't look like a valid email.")).toBeVisible();

		// Fix it → all email hints clear.
		await page.getByLabel('Email').fill('me@example.com');
		await expect(page.getByText("That doesn't look like a valid email.")).toHaveCount(0);
		await expect(page.getByText('Enter your email address.')).toHaveCount(0);

		// Type 8+ char password → password hint flips to '✓ Strong enough'.
		await page.getByLabel('Password').fill('abcdefgh');
		await expect(page.getByText('✓ Strong enough.')).toBeVisible();
	});

	test('duplicate email shows friendly message + Log in link', async ({ page }) => {
		// Reuse an account so the second signup hits the duplicate-email path.
		const email = uniqueEmail('dup');
		await signupAndLogin(page, { email });

		// Sign out + retry signup with the same email.
		await page.goto('/signup');
		await page.waitForLoadState('networkidle');
		await page.getByLabel('Name').fill('Other Person');
		await page.getByLabel('Email').fill(email);
		await page.getByLabel('Password').fill('testpass123456');
		await page.getByRole('button', { name: 'Sign up' }).click();

		await expect(page.getByText('An account already exists with that email.')).toBeVisible({
			timeout: 10_000
		});
		const loginLink = page.getByRole('link', { name: 'Log in instead' });
		await expect(loginLink).toBeVisible();
		await expect(loginLink).toHaveAttribute('href', '/login');
	});
});
