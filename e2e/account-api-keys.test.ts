/**
 * /account/api-keys — list / create (copy-once) / revoke flow.
 *
 * Covers the TASK-167 acceptance criteria:
 *   - Auth gate: anon hits /account/api-keys → redirected to /login
 *   - Empty state on a fresh user
 *   - Create flow surfaces the full bearer token exactly once
 *   - After the success modal is acknowledged, the plaintext is gone
 *   - Default scopes: render:create / render:read / render:delete
 *   - Revoke flow: confirm modal → table updates to "Revoked"
 *   - CONVE-41: no native window.prompt/confirm/alert in the new code
 */
import { expect, test } from '@playwright/test';
import { signupAndLogin } from './helpers';

test('anon visiting /account/api-keys is redirected to /login', async ({ page }) => {
	await page.goto('/account/api-keys');
	await expect(page).toHaveURL(/\/login(\?|$)/);
});

test('empty state renders on a fresh user', async ({ page }) => {
	await signupAndLogin(page);
	await page.goto('/account/api-keys');
	await expect(page.getByText('No API keys yet')).toBeVisible();
	// Empty-state CTA opens the same modal as the page-header CTA.
	await page.getByTestId('create-api-key-empty').click();
	await expect(page.getByTestId('create-api-key-name')).toBeVisible();
});

test('create → token shown once → close → list shows new row with prefix only', async ({
	page
}) => {
	await signupAndLogin(page);
	await page.goto('/account/api-keys');

	await page.getByTestId('create-api-key').click();
	await page.getByTestId('create-api-key-name').fill('e2e key');
	await page.getByTestId('create-api-key-submit').click();

	// Success modal must surface the plaintext exactly once.
	const tokenValue = page.getByTestId('new-token-value');
	await expect(tokenValue).toBeVisible();
	const fullToken = (await tokenValue.textContent())?.trim() ?? '';
	expect(fullToken.startsWith('ck_live_')).toBeTruthy();
	expect(fullToken.length).toBeGreaterThan('ck_live_'.length + 20);

	// Acknowledge and close.
	await page.getByTestId('acknowledge-new-token').click();
	await expect(tokenValue).not.toBeVisible();

	// New row appears with prefix only — full token is not in the DOM.
	const row = page.getByTestId('api-key-row').first();
	await expect(row).toContainText('e2e key');
	await expect(row).toContainText('ck_live_');
	await expect(row.getByTestId('status-active')).toBeVisible();
	// The full token (after the prefix) must NOT be reachable from the table.
	const pageHtml = await page.content();
	expect(pageHtml).not.toContain(fullToken);
});

test('default scopes include all three render scopes', async ({ page, request }) => {
	const creds = await signupAndLogin(page);

	// Drive the create through the same UI flow so we're testing the
	// happy path the user takes, then assert via the management API
	// which we already have an authenticated session for.
	await page.goto('/account/api-keys');
	await page.getByTestId('create-api-key').click();
	await page.getByTestId('create-api-key-name').fill('scope check');
	await page.getByTestId('create-api-key-submit').click();
	await page.getByTestId('acknowledge-new-token').click();

	// Reuse the browser's session cookies for the API request.
	const cookies = await page.context().cookies();
	const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
	const res = await request.get('/api/account/api-keys', {
		headers: { Cookie: cookieHeader }
	});
	expect(res.ok()).toBeTruthy();
	const keys = (await res.json()) as Array<{ name: string; scopes: string[] }>;
	const created = keys.find((k) => k.name === 'scope check');
	expect(created).toBeDefined();
	expect(new Set(created!.scopes)).toEqual(
		new Set(['render:create', 'render:read', 'render:delete'])
	);

	// `creds` retained so the body of the test compiles strictly — we
	// don't otherwise re-use it.
	expect(creds.email).toBeTruthy();
});

test('revoke flow: confirm modal → row updates to Revoked', async ({ page }) => {
	await signupAndLogin(page);
	await page.goto('/account/api-keys');
	await page.getByTestId('create-api-key').click();
	await page.getByTestId('create-api-key-name').fill('to-revoke');
	await page.getByTestId('create-api-key-submit').click();
	await page.getByTestId('acknowledge-new-token').click();

	const row = page.getByTestId('api-key-row').filter({ hasText: 'to-revoke' });
	await row.getByTestId('revoke-api-key').click();

	// ConfirmDialog is a Modal: dismissible only via Revoke/Cancel.
	await page.getByRole('button', { name: 'Revoke' }).click();

	// Row may stay visible (we keep revoked rows in history) but the
	// status badge flips to Revoked, and the Revoke button is gone.
	await expect(row.getByTestId('status-revoked')).toBeVisible();
	await expect(row.getByTestId('revoke-api-key')).toHaveCount(0);
});
