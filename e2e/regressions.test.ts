/**
 * Regression guards — every assertion here corresponds to a v0.2 polish
 * win that an earlier audit found broken. Future commits MUST NOT
 * silently regress these.
 *
 *   1. No window.prompt / confirm / alert called during any flow
 *   2. Mobile-banner appears below 1024px on the editor route
 *   3. Disabled toolbar buttons have cursor:not-allowed and softer color
 *   4. Dashboard empty state contains the product pitch + 'Try an example'
 *   5. All icon-only toolbar buttons have a non-empty aria-label
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer, publish } from './helpers';

test.describe('v0.2 UX regressions', () => {
	test('no native window.prompt/confirm/alert during any user flow', async ({ page }) => {
		// Override the natives BEFORE navigation so any call from app code
		// pushes onto the array. We assert it stayed empty after walking the
		// full happy path — same flow shape as TASK-47 but condensed.
		await page.addInitScript(() => {
			const w = window as unknown as {
				__nativeDialogCalls: string[];
				prompt: typeof window.prompt;
				confirm: typeof window.confirm;
				alert: typeof window.alert;
			};
			w.__nativeDialogCalls = [];
			w.prompt = (...args: unknown[]) => {
				w.__nativeDialogCalls.push(`prompt(${JSON.stringify(args)})`);
				return null;
			};
			w.confirm = (...args: unknown[]) => {
				w.__nativeDialogCalls.push(`confirm(${JSON.stringify(args)})`);
				return false;
			};
			w.alert = (...args: unknown[]) => {
				w.__nativeDialogCalls.push(`alert(${JSON.stringify(args)})`);
			};
		});

		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'No native dialogs', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);
		await addTextLayer(page, 'Hello');
		await publish(page);

		const calls = await page.evaluate(
			() => (window as unknown as { __nativeDialogCalls: string[] }).__nativeDialogCalls
		);
		expect(calls, 'No native dialogs should fire during signup → publish').toEqual([]);
	});

	test('editor route shows the mobile banner below 1024px', async ({ page }) => {
		// Set a mobile viewport BEFORE login so the banner's initial state
		// already reflects the small width.
		await page.setViewportSize({ width: 600, height: 900 });
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Mobile', preset: 'OG Image' });
		// gotoEditor waits for the toolbar testid; the banner is an overlay
		// above the toolbar so it should be visible too.
		await page.goto(`/canvas/${canvas.id}/edit`);
		await expect(page.getByRole('dialog', { name: /editor works best/i })).toBeVisible({
			timeout: 10_000
		});
	});

	test('dashboard empty state pitches the product + offers a starter template', async ({
		page
	}) => {
		await signupAndLogin(page);
		// Brand-new user → empty state.
		await expect(page.getByRole('heading', { name: 'Design once, share anywhere' })).toBeVisible();
		// The 2-3 sentence pitch should mention the parameter mechanic.
		await expect(page.getByText(/URL parameters?/i)).toBeVisible();
		// 'Try an example' CTA from TASK-33.
		await expect(page.getByRole('button', { name: /Try an example/ })).toBeVisible();
	});

	test('disabled toolbar buttons get cursor:not-allowed and dimmed contrast', async ({ page }) => {
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Disabled state', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);

		// Empty canvas: undo + redo are both disabled.
		const undo = page.getByTestId('toolbar-undo');
		const redo = page.getByTestId('toolbar-redo');
		await expect(undo).toBeDisabled();
		await expect(redo).toBeDisabled();

		// Computed cursor should be not-allowed (TASK-32). Color is dimmed
		// relative to active state — assert the disabled styles set them
		// apart from a baseline opacity of 1, since reading exact rgb is
		// brittle across browser font-rendering tweaks.
		const cursor = await redo.evaluate((el) => getComputedStyle(el).cursor);
		expect(cursor).toBe('not-allowed');
		const opacity = await redo.evaluate((el) => parseFloat(getComputedStyle(el).opacity));
		expect(opacity).toBeLessThan(1);
	});

	test('every icon-only toolbar button has a non-empty aria-label', async ({ page }) => {
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'A11y', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);

		// All icon-only buttons in the toolbar must declare an aria-label so
		// screen readers can announce them. The lucide-only redesign in
		// TASK-29 enforced this — keep it enforced here.
		const labels = await page.locator('.toolbar .icon-only').evaluateAll((nodes) =>
			nodes.map((n) => ({
				html: n.outerHTML.slice(0, 80),
				ariaLabel: (n as HTMLElement).getAttribute('aria-label') ?? ''
			}))
		);
		// At least the two we know about (undo + redo).
		expect(labels.length).toBeGreaterThanOrEqual(2);
		for (const { ariaLabel } of labels) {
			expect(ariaLabel.trim().length).toBeGreaterThan(0);
		}
	});
});
