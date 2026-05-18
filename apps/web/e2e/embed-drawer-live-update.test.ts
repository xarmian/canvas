/**
 * Embed drawer — live-update loop (PLAN-232 Phase B / TASK-241).
 *
 * The core UX payoff of moving the embed snippet generator out of the
 * publish modal and into a non-blocking drawer is: the drawer can
 * stay open while the user edits a testParam in the preview panel,
 * and the snippet textarea updates reactively without close/reopen.
 *
 * This test verifies that loop end-to-end:
 *  1. Bind a param, publish.
 *  2. Open the preview panel BEFORE the drawer (the drawer overlays
 *     the right edge of the toolbar including the Preview button —
 *     opening preview first leaves both surfaces interactable).
 *  3. Open the embed drawer.
 *  4. Edit `title` in the preview panel.
 *  5. Assert the drawer's URL-tab snippet picks up the new value
 *     WITHOUT closing/reopening the drawer.
 *  6. Toggle Include-example-values + switch tabs — both should be
 *     instant (no remount, no re-fetch, no flash of empty state).
 */
import { test, expect } from '@playwright/test';
import {
	signupAndLogin,
	createCanvas,
	addTextLayer,
	bindParam,
	publish,
	openEmbedDrawer
} from './helpers';

test.describe('Embed drawer — live-update loop', () => {
	test('editing a testParam in the preview panel updates the drawer snippet without close/reopen', async ({
		page
	}) => {
		await signupAndLogin(page);
		await createCanvas(page);
		await addTextLayer(page, 'Hello world');
		await bindParam(page, 'Text Content', 'title', 'Hello');

		await publish(page);

		// Close the publish modal so the toolbar's Preview + Embed
		// buttons are reachable (the modal inerts the page).
		await page.getByRole('button', { name: 'Close' }).click();

		// Open the preview panel BEFORE the drawer. The drawer is a
		// `position: fixed` overlay on the right and covers the
		// rightmost portion of the toolbar including the Preview
		// button; if we tried to open Preview second, the click
		// wouldn't land. The preview panel itself renders below the
		// canvas in normal flow, so it remains interactable once the
		// drawer is also open.
		await page.getByRole('button', { name: /^Preview$/ }).click();
		const titleInput = page.locator('#test-param-title');
		await expect(titleInput).toBeVisible({ timeout: 5_000 });

		// Open the embed drawer. Include-example-values defaults to
		// off — we enable it so the snippet text actually contains
		// `title=...` and the live edit has something visible to flip.
		await openEmbedDrawer(page);
		await page.getByRole('checkbox', { name: /Include example values/ }).check();

		// Park on the URL tab so the assertion target is a simple
		// query string. (HTML / Markdown / OG all encode the same
		// resolved value through `buildQueryString`; URL is the
		// shortest snippet to read.)
		await page.getByTestId('embed-tab-url').click();
		const snippet = page.getByTestId('embed-snippet');

		// Baseline — the binding default 'Hello' resolved through
		// resolveExampleValue when the user hasn't typed a testParam
		// value yet.
		await expect.poll(async () => await snippet.inputValue()).toContain('title=Hello');

		// ↓ The actual live-update assertion. Drawer stays open while
		// we type into the preview panel input. The snippet should
		// update on the next reactive tick — no close/reopen.
		await titleInput.fill('UpdatedLive');
		await expect
			.poll(async () => await snippet.inputValue(), { timeout: 5_000 })
			.toContain('title=UpdatedLive');

		// Empty fall-through: `resolveExampleValue` returns the
		// binding default when the testParam is empty. Round-tripping
		// to '' should restore the snippet to use 'Hello' again.
		await titleInput.fill('');
		await expect
			.poll(async () => await snippet.inputValue(), { timeout: 5_000 })
			.toContain('title=Hello');
	});

	test('switching tabs while the drawer is open is instant and preserves include-values + sub-toggle state', async ({
		page
	}) => {
		await signupAndLogin(page);
		await createCanvas(page);
		await addTextLayer(page, 'Hello world');
		await bindParam(page, 'Text Content', 'title', 'Hello');

		await publish(page);
		await page.getByRole('button', { name: 'Close' }).click();
		await openEmbedDrawer(page);

		// Enable include-values + flip TS to Typed once; both states
		// are component-local and must survive a round-trip through
		// the other tabs without resetting.
		await page.getByRole('checkbox', { name: /Include example values/ }).check();
		await page.getByTestId('embed-tab-typescript').click();
		await page.getByTestId('ts-flavor-typed').click();
		await expect(page.getByTestId('ts-flavor-typed')).toHaveAttribute('aria-pressed', 'true');

		// Walk through several tabs and back — the textarea should
		// always have non-empty content (i.e. no flash-of-empty
		// during the switch — would imply a remount/re-fetch). Read
		// inputValue() synchronously after each click rather than
		// awaiting an auto-retrying matcher; a flash-of-empty
		// satisfies `expect(...).not.toHaveValue('')` once the value
		// re-fills, so the assertion has to capture the value at the
		// moment we'd see the flash. (Codex round 1 P3 on TASK-241.)
		const snippet = page.getByTestId('embed-snippet');
		for (const tab of ['html', 'markdown', 'og', 'url', 'curl', 'typescript', 'python'] as const) {
			await page.getByTestId(`embed-tab-${tab}`).click();
			const value = await snippet.inputValue();
			expect(value, `embed-tab-${tab} textarea was empty after click`).not.toBe('');
		}

		// Back on TS: include-values checkbox still on, sub-toggle
		// still Typed.
		await page.getByTestId('embed-tab-typescript').click();
		await expect(page.getByRole('checkbox', { name: /Include example values/ })).toBeChecked();
		await expect(page.getByTestId('ts-flavor-typed')).toHaveAttribute('aria-pressed', 'true');
	});
});
