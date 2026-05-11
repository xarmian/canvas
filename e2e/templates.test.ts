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

		// TASK-149 regression: the OG card template defines
		// backgroundValue: '#0f172a'. Fabric v7's loadFromJSON internally
		// calls canvas.clear() which resets backgroundColor — so unless the
		// editor re-applies the background after hydration, the template
		// renders on a default (transparent/white) canvas and looks nothing
		// like the gallery preview. Read pixel (0,0) of Fabric's lower
		// canvas: the OG card has its content offset from the top-left, so
		// (0,0) is pure background paint with no overlapping layers.
		// expect.poll handles the post-hydration paint timing without an
		// arbitrary sleep.
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const lower = document.querySelector(
							'.canvas-wrapper .lower-canvas'
						) as HTMLCanvasElement | null;
						if (!lower) return null;
						const ctx = lower.getContext('2d', { willReadFrequently: true });
						if (!ctx) return null;
						const { data } = ctx.getImageData(0, 0, 1, 1);
						// Skip while the pixel is still transparent — Fabric paints the
						// background synchronously during renderAll, so transparent means
						// hydration's renderAll hasn't run yet.
						if (data[3] === 0) return null;
						const hex = (n: number) => n.toString(16).padStart(2, '0');
						return `#${hex(data[0])}${hex(data[1])}${hex(data[2])}`;
					}),
				{ timeout: 5_000, message: 'template background not painted on editor canvas' }
			)
			.toBe('#0f172a');
	});

	test('zoom: auto-fits oversized canvas, scales to 100% on toolbar click, preview bytes stay at intrinsic dims (TASK-150)', async ({
		page
	}) => {
		// Force a viewport narrower than the canvas (1200 wide) so auto-fit
		// is meaningfully exercised. Editor side panels eat ~600px, so this
		// guarantees the available width for the canvas is well under 1200.
		await page.setViewportSize({ width: 1100, height: 700 });
		await signupAndLogin(page);

		await page.getByTestId('nav-templates').click();
		await page.waitForURL('**/templates');
		const ogCard = page.locator('[data-template-id="og-card"]');
		await ogCard.getByTestId('template-use').click();
		await page.waitForURL(/\/canvas\/[^/]+\/edit$/, { timeout: 10_000 });
		// Wait for the canvas wrapper to mount + initial fit to apply.
		await expect(page.locator('.canvas-stage')).toBeVisible({ timeout: 5_000 });

		// Auto-fit produced a scale < 1 (canvas is wider than the visible
		// container at this viewport). Polled because the initial fit runs
		// in a requestAnimationFrame after mount.
		await expect
			.poll(
				async () =>
					page
						.locator('.canvas-stage')
						.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--canvas-scale'))),
				{ timeout: 5_000, message: 'expected auto-fit to scale canvas below 1.0' }
			)
			.toBeLessThan(1);

		// The toolbar value displays "Fit" (because fit-mode and scale != 1.0).
		const zoomValue = page.getByTestId('toolbar-zoom-value');
		await expect(zoomValue).toHaveText('Fit');

		// Click the value button — should toggle to 100% (manual mode).
		await zoomValue.click();
		await expect(zoomValue).toHaveText('100%');
		const scaleAt100 = await page
			.locator('.canvas-stage')
			.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--canvas-scale')));
		expect(scaleAt100).toBeCloseTo(1, 3);

		// Click again — should toggle back to Fit.
		await zoomValue.click();
		await expect(zoomValue).toHaveText('Fit');

		// Zoom-out button decreases scale; zoom-in increases.
		const beforeOut = await page
			.locator('.canvas-stage')
			.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--canvas-scale')));
		await page.getByTestId('toolbar-zoom-out').click();
		const afterOut = await page
			.locator('.canvas-stage')
			.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--canvas-scale')));
		expect(afterOut).toBeLessThan(beforeOut);
		await page.getByTestId('toolbar-zoom-in').click();
		const afterIn = await page
			.locator('.canvas-stage')
			.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--canvas-scale')));
		expect(afterIn).toBeGreaterThan(afterOut);

		// The Fabric canvas's intrinsic dimensions (HTML attributes) stay
		// at the authored canvas size regardless of zoom — this is the
		// guarantee that exports / save / hit-testing aren't affected by
		// editor-only zoom. Playwright Chromium defaults to DPR=1, so the
		// backing buffer matches the CSS dimensions exactly.
		const intrinsic = await page.locator('.lower-canvas').evaluate((c) => ({
			width: (c as HTMLCanvasElement).width,
			height: (c as HTMLCanvasElement).height
		}));
		expect(intrinsic.width).toBe(1200);
		expect(intrinsic.height).toBe(630);

		// Preview bytes are independent of zoom level and viewport. Open
		// the preview and assert the server-rendered PNG comes back at the
		// canvas's authored dimensions.
		await page.locator('button.tool-btn', { hasText: 'Preview' }).click();
		const previewImg = page.locator('.preview-image img');
		await expect(previewImg).toBeVisible({ timeout: 5_000 });
		await expect
			.poll(
				async () =>
					previewImg.evaluate((img) => {
						const i = img as HTMLImageElement;
						return i.naturalWidth > 0 ? i.naturalWidth : null;
					}),
				{ timeout: 5_000, message: 'preview PNG did not load' }
			)
			.toBe(1200);
		const previewNaturalH = await previewImg.evaluate(
			(img) => (img as HTMLImageElement).naturalHeight
		);
		expect(previewNaturalH).toBe(630);
	});
});
