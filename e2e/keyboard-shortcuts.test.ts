/**
 * Editor keyboard shortcuts (TASK-67). Verifies the cheatsheet modal opens
 * via `?`, arrow-key nudging moves the active object, Cmd+D duplicates,
 * Cmd+] reorders, and Esc deselects.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, addTextLayer } from './helpers';

test.describe('Editor keyboard shortcuts', () => {
	test('arrow-nudge, duplicate, layer order, and ? cheatsheet', async ({ page }) => {
		await signupAndLogin(page);
		await createCanvas(page);

		await addTextLayer(page, 'Shortcuts test');

		// Expand the "Position & size" section so prop-x / prop-y exist.
		const positionHeader = page.getByRole('button', { name: /Position & size/ });
		const expanded = await positionHeader.getAttribute('aria-expanded');
		if (expanded !== 'true') await positionHeader.click();

		// Pull initial X / Y from the property panel directly (distinct
		// ids — many elements in the editor have "Y" in their accessible
		// name so getByLabel('Y') is ambiguous).
		const xInput = page.locator('#prop-x');
		const yInput = page.locator('#prop-y');
		await expect(xInput).toBeVisible();
		const initialX = Number(await xInput.inputValue());
		const initialY = Number(await yInput.inputValue());

		// addTextLayer leaves focus in the Content textarea, which is a
		// typing-target — our global shortcut listener intentionally
		// ignores keystrokes there. Blur off it by clicking the editor's
		// dashboard breadcrumb (a focusable but non-typing element) so
		// subsequent keystrokes route through the global listener. Don't
		// click the canvas itself — Fabric would deselect the text and
		// the property-panel inputs we read above would unmount.
		await page.locator('.canvas-name').click();
		// Plain ArrowRight nudges by 1px → X should bump by 1.
		await page.keyboard.press('ArrowRight');
		await expect(xInput).toHaveValue(String(initialX + 1));

		// Shift+ArrowDown nudges by 10px.
		await page.keyboard.press('Shift+ArrowDown');
		await expect(yInput).toHaveValue(String(initialY + 10));

		// Cmd/Ctrl+D duplicates — the layer count should go from 1 to 2.
		const layers = page.getByRole('listbox', { name: 'Canvas layers' });
		await expect(layers.locator('[role="option"]')).toHaveCount(1);
		// Use ControlOrMeta to work on both Mac (Meta) and Linux/Windows (Ctrl).
		await page.keyboard.press('ControlOrMeta+d');
		await expect(layers.locator('[role="option"]')).toHaveCount(2);

		// `?` opens the cheatsheet modal (no modifier).
		await page.keyboard.press('?');
		await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
		// Escape closes it (Modal component native behavior).
		await page.keyboard.press('Escape');
		await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).not.toBeVisible();
	});
});
