/**
 * Embed drawer — pre-publish state (PLAN-232 Phase B / TASK-242).
 *
 * The drawer renders snippets even when the canvas is unpublished, so
 * developers can plan their integration before going live. To keep
 * users from copying URLs that 404, a banner is shown explaining the
 * state and offering a one-click route into the publish modal.
 *
 * What this test verifies:
 *  1. Pre-publish: banner is visible, the snippets still render
 *     (with the eventual share URL).
 *  2. The banner's "Publish now" CTA opens the publish modal — the
 *     same flow the toolbar button drives.
 *  3. After publishing through the modal and closing it, the banner
 *     disappears.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, addTextLayer, openEmbedDrawer } from './helpers';

test.describe('Embed drawer — pre-publish state', () => {
	test('banner is visible when unpublished, hides after publish, CTA opens the publish modal', async ({
		page
	}) => {
		await signupAndLogin(page);
		await createCanvas(page);
		await addTextLayer(page, 'Hello');

		// Open the drawer on the unpublished canvas. openEmbedDrawer
		// closes any open dialog first (no-op here since the publish
		// modal isn't open yet) and then clicks toolbar-embed.
		await openEmbedDrawer(page);

		// Pre-publish banner is visible; snippets still render so the
		// user can see what they'll get post-publish.
		const banner = page.getByTestId('embed-drawer-pre-publish-banner');
		await expect(banner).toBeVisible();
		await expect(banner).toContainText('Not yet published');
		await expect(page.getByTestId('embed-section')).toBeVisible();
		await expect(page.getByTestId('embed-snippet')).toBeVisible();

		// CTA opens the publish modal. We don't go all the way through
		// publish here — that's covered elsewhere in publish-modal-*
		// tests. The drawer-side contract is: clicking "Publish now"
		// routes the user to the canonical publish flow.
		await page.getByTestId('embed-drawer-publish-cta').click();
		await expect(page.getByRole('button', { name: 'Publish canvas' })).toBeVisible({
			timeout: 5_000
		});

		// Complete the publish + close the modal. The drawer should
		// reflect `published=true` reactively and hide the banner.
		await page.getByRole('button', { name: 'Publish canvas' }).click();
		// Wait for the modal to settle on the published branch
		// (Share page URL field is the canonical "I'm published now"
		// signal). exact: true so 'Image URL' doesn't also match
		// 'Example image URL'.
		await expect(page.getByLabel('Share page URL', { exact: true })).toBeVisible({
			timeout: 10_000
		});
		// Scope the Close click to the dialog — the embed drawer also
		// has a close button (aria-label "Close embed drawer") so an
		// unscoped getByRole('button', { name: 'Close' }) resolves to
		// two elements and fails strict mode.
		await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

		// Drawer is still open from earlier; banner has gone away.
		await expect(banner).toBeHidden();
		// And the snippet textarea is still mounted (no remount on
		// the published→unpublished transition).
		await expect(page.getByTestId('embed-snippet')).toBeVisible();
	});
});
