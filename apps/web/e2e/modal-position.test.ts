/**
 * TASK-151 regression: editor modals must open centered in the viewport.
 *
 * The Modal component (src/lib/components/ui/Modal.svelte) uses native
 * `<dialog>` + `showModal()`, which the user agent centers via
 * `margin: auto` on top of the top-layer `position: fixed; inset: 0`.
 * Tailwind 4's Preflight zeroes dialog margins, which pinned the modal
 * to top-left of the viewport (the user-reported bug). The fix explicitly
 * restores `margin: auto` on `.modal`; this spec verifies multiple modal
 * types end up centered (±5px) so a future Preflight upgrade can't
 * silently regress.
 *
 * Why measure multiple modal types: the bug was in a shared component,
 * but a future split (per-modal CSS, or migration to a non-`<dialog>`
 * primitive) could regress only some modals. Covering Settings + Cheatsheet
 * + Image catches both wide and narrow dialogs.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas } from './helpers';

async function getOpenModalCenterOffset(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		const dlg = document.querySelector('dialog.modal[open]') as HTMLDialogElement | null;
		if (!dlg) return null;
		const r = dlg.getBoundingClientRect();
		return {
			dx: Math.abs(r.x + r.width / 2 - window.innerWidth / 2),
			dy: Math.abs(r.y + r.height / 2 - window.innerHeight / 2),
			w: r.width,
			h: r.height
		};
	});
}

test.describe('Editor modals are viewport-centered (TASK-151)', () => {
	test('Canvas Settings modal centers on open', async ({ page }) => {
		await signupAndLogin(page);
		await createCanvas(page);

		// Toolbar's "1200×630" button opens the settings modal.
		await page.locator('button.tool-btn', { hasText: '1200×630' }).click();
		await expect(page.locator('dialog.modal[open]')).toBeVisible({ timeout: 5_000 });

		const offset = await getOpenModalCenterOffset(page);
		expect(offset, 'open settings dialog not found').not.toBeNull();
		expect(offset!.dx).toBeLessThanOrEqual(5);
		expect(offset!.dy).toBeLessThanOrEqual(5);
	});

	test('Shortcuts cheatsheet centers on open', async ({ page }) => {
		await signupAndLogin(page);
		await createCanvas(page);

		// Keyboard shortcut "?" opens the cheatsheet modal. Use the
		// toolbar button (aria-label "Keyboard shortcuts (?)") so the
		// test doesn't depend on global keydown timing.
		await page.getByRole('button', { name: 'Keyboard shortcuts (?)' }).click();
		await expect(page.locator('dialog.modal[open]')).toBeVisible({ timeout: 5_000 });

		const offset = await getOpenModalCenterOffset(page);
		expect(offset).not.toBeNull();
		expect(offset!.dx).toBeLessThanOrEqual(5);
		expect(offset!.dy).toBeLessThanOrEqual(5);
	});

	test('Add Image modal centers on open', async ({ page }) => {
		await signupAndLogin(page);
		await createCanvas(page);

		// Toolbar's "Image" button opens AddImageModal.
		await page.locator('button.tool-btn', { hasText: 'Image' }).click();
		await expect(page.locator('dialog.modal[open]')).toBeVisible({ timeout: 5_000 });

		const offset = await getOpenModalCenterOffset(page);
		expect(offset).not.toBeNull();
		expect(offset!.dx).toBeLessThanOrEqual(5);
		expect(offset!.dy).toBeLessThanOrEqual(5);
	});
});
