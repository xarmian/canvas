/**
 * Editor UX coverage — locks down v0.2 polish wins so future changes can't
 * silently regress them. Drives the editor through the helpers from
 * TASK-44.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer } from './helpers';

test.describe('Editor UX', () => {
	test.beforeEach(async ({ page }) => {
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Editor UX', preset: 'OG / Twitter' });
		await gotoEditor(page, canvas.id);
	});

	test('toolbar uses lucide icons (no emoji or unicode arrows)', async ({ page }) => {
		// v0.2 replaced emoji + unicode arrow icons (↩ ↪ 📝 🖼️ 👁️ 🔒) with
		// lucide-svelte. Assert SVG exists in toolbar and that no codepoints
		// from the emoji / Unicode-Arrow blocks leak into the toolbar text.
		const toolbar = page.getByTestId('editor-toolbar');
		await expect(toolbar.locator('svg').first()).toBeVisible();

		// Pull all toolbar text (visible + tooltip + aria-label) and assert
		// no emoji-block or arrow-block characters appear. The regex covers
		// emoji presentation + variation selector + the historical 'arrow'
		// codepoints (U+2190..U+21FF) the v0.1 toolbar used.
		const text = await toolbar.evaluate((node) => {
			const collected: string[] = [node.textContent ?? ''];
			for (const el of node.querySelectorAll<HTMLElement>('[aria-label], [title]')) {
				if (el.getAttribute('aria-label')) collected.push(el.getAttribute('aria-label')!);
				if (el.getAttribute('title')) collected.push(el.getAttribute('title')!);
			}
			return collected.join(' ');
		});
		const banned = /[←-⇿\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
		expect(text).not.toMatch(banned);
	});

	test('property panel renders Text → Dynamic → Position (Position collapsed)', async ({
		page
	}) => {
		// Selecting a text layer is the precondition for all three sections
		// to render. addTextLayer() leaves the new object selected.
		await addTextLayer(page, 'Hello');

		// Capture the property panel's section testids in DOM order — the
		// only order-sensitive assertion that survives CSS/layout refactors.
		const sectionIds = await page
			.locator('[data-testid^="property-section-"]')
			.evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).getAttribute('data-testid')));
		expect(sectionIds).toEqual([
			'property-section-text',
			'property-section-dynamic',
			'property-section-conditionals',
			'property-section-position'
		]);

		// Position section is collapsed by default (TASK-30 acceptance).
		const positionToggle = page
			.getByTestId('property-section-position')
			.getByRole('button', { name: /Position/ });
		await expect(positionToggle).toHaveAttribute('aria-expanded', 'false');
		// X/Y/W/H inputs are inside the {#if positionExpanded} block, so they
		// should be absent from the DOM until the user expands the section.
		await expect(page.getByLabel('X', { exact: true })).toHaveCount(0);
	});

	test('add text layer + inline edit content via property panel', async ({ page }) => {
		await addTextLayer(page, 'First version');
		const content = page.getByLabel('Content');
		await expect(content).toHaveValue('First version');

		// Edit again — the property panel should commit and keep the new
		// value in the field. (Verifies the textarea is bound, not just
		// rendered.)
		await content.fill('Second version');
		await expect(content).toHaveValue('Second version');
	});

	test('undo/redo enabled-state matches history', async ({ page }) => {
		const undo = page.getByTestId('toolbar-undo');
		const redo = page.getByTestId('toolbar-redo');

		// Empty canvas: nothing to undo or redo.
		await expect(undo).toBeDisabled();
		await expect(redo).toBeDisabled();

		// Adding a text layer creates a history entry → undo enabled, redo still off.
		await addTextLayer(page, 'Undoable');
		await expect(undo).toBeEnabled();
		await expect(redo).toBeDisabled();

		// Performing the undo flips the state — redo becomes enabled. Undo
		// may or may not still be enabled depending on whether the editor
		// kept a baseline snapshot before the empty load (it does for some
		// init paths). The important regression guard is the redo flip.
		await undo.click();
		await expect(redo).toBeEnabled();
	});

	test('canvas dimensions modal opens and applies new size', async ({ page }) => {
		const sizeBtn = page.getByTestId('toolbar-canvas-size');
		// OG / Twitter preset: starts at 1200×630.
		await expect(sizeBtn).toHaveText(/1200×630/);
		await sizeBtn.click();

		// Modal renders Twitter Card preset (1200×600). Picking it should
		// adjust the inputs in-modal, then Apply persists and closes.
		await expect(page.getByRole('heading', { name: 'Canvas settings' })).toBeVisible();
		await page.getByRole('radio', { name: /Twitter Card/ }).check();
		await page.getByRole('button', { name: 'Apply' }).click();

		// Modal closes → the size button label reflects the new dimensions.
		await expect(page.getByRole('heading', { name: 'Canvas settings' })).toBeHidden();
		await expect(sizeBtn).toHaveText(/1200×600/);
	});
});
