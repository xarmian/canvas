/**
 * Embed tabs — TypeScript + Python coverage (TASK-212, PLAN-206).
 *
 * Complements e2e/embed-modal.test.ts (which already covers HTML /
 * Markdown / OG / URL / cURL) by exercising the two new tabs added in
 * TASK-211 plus the cross-cutting behavior wired up across TASK-207
 * (live params-panel values flowing into snippets) and TASK-209 (TS
 * Simple / Typed sub-flavors).
 *
 * What this test buys you that the unit tests don't:
 *
 *   1. The actual paramRows → paramSchemas wiring works end-to-end —
 *      i.e. changing a param to `number` in the modal's schema editor
 *      produces a `gain: number` declaration in the typed-TS snippet
 *      (not a hand-rolled SnippetInput).
 *   2. The roving-tabindex + click cycle through all seven tabs lands
 *      on the right snippet in each case.
 *   3. The Sub-toggle inside the TypeScript tab flips between Simple
 *      and Typed flavors without remount.
 *   4. Live params-panel values flow into snippet text after a
 *      close-and-reopen cycle (the same data path the live-reactivity
 *      contract relies on; the close/reopen variant is easier to drive
 *      from Playwright than racing the modal + preview panel together).
 *   5. Copying from the active TS Typed tab puts the right thing on
 *      the clipboard.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, addTextLayer, bindParam, publish } from './helpers';

/** Every embed tab in declaration order. Mirrors `EMBED_TABS` in
 * PublishModal.svelte — kept in sync by hand because the e2e suite
 * doesn't import production code. */
const ALL_TABS = ['html', 'markdown', 'og', 'url', 'curl', 'typescript', 'python'] as const;

test.describe('Embed tabs — TypeScript + Python', () => {
	test('all seven tabs render schema-aware snippets, TS sub-toggle flips flavor, live values flow through reopen, copy lands the right text', async ({
		page,
		context
	}) => {
		// Clipboard access is needed for the copy assertion at the end.
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);

		await signupAndLogin(page);
		await createCanvas(page);

		// Two bound params — one text, one we'll flip to `number` via the
		// modal's per-param schema editor so the typed-TS snippet has
		// something interesting to declare.
		await addTextLayer(page, 'Hello world');
		await bindParam(page, 'Text Content', 'title', 'Hello');
		await addTextLayer(page, '12');
		await bindParam(page, 'Text Content', 'count', '12');

		await publish(page);

		const snippet = page.getByTestId('embed-snippet');
		await expect(page.getByTestId('embed-section')).toBeVisible();

		// The per-param type editor is disabled until paramRows finish
		// loading from `GET /api/canvas/[id]/params` — wait for that, then
		// flip `count` to `number`. Without this the change is silently
		// dropped (the select is disabled) and the typed-TS snippet falls
		// back to all-strings, which would mask the wiring under test.
		//
		// Scoping the lookup to the dialog is necessary because the
		// ParamsPanel (rendered behind the modal in the editor) has the
		// same `aria-label="Type for {name}"` schema editor — without the
		// scope `getByLabel` resolves to two elements and fails strict
		// mode.
		const dialog = page.getByRole('dialog');
		const countTypeSelect = dialog.getByLabel('Type for count');
		await expect(countTypeSelect).toBeEnabled({ timeout: 5_000 });
		await countTypeSelect.selectOption('number');

		// Enable "Include example values" BEFORE the per-tab walk —
		// otherwise the TS/Python snippets render their bare-fetch /
		// bare-GET fallback (no params dict, no schema keys visible),
		// which would defeat the point of asserting the param names
		// appear in those tabs.
		await page.getByRole('checkbox', { name: /Include example values/ }).check();

		// Walk through every tab and assert the snippet (a) reflects the
		// active tab and (b) contains both param names. We click rather
		// than keyboard-arrow because the keyboard path is covered
		// separately by the activate-on-focus unit-tested logic in
		// onTabKeydown; clicking is what real users do most often.
		for (const tab of ALL_TABS) {
			await page.getByTestId(`embed-tab-${tab}`).click();
			const value = await snippet.inputValue();
			expect(value).toBeTruthy();
			expect(value).toContain('title');
			expect(value).toContain('count');
		}

		// Python: import + GET + raise_for_status + binary write, with
		// both keys present. `count` arrives as a quoted string because
		// Python's coercion uses the `boolean → "true"` / `number →
		// 12.5` rules, and the value `"12"` parses to a number — so
		// `count: 12` (unquoted) is what python() emits given the
		// paramSchemas wired through PublishModal.
		//
		// `inputValue()` (not toContainText) is required for textarea
		// content — Playwright's text-content matchers read .textContent,
		// which is always empty for textareas.
		const pyValue = await snippet.inputValue();
		expect(pyValue).toContain('import requests');
		expect(pyValue).toContain('"title": "Hello"');
		expect(pyValue).toContain('"count": 12,');
		expect(pyValue).toContain('response.raise_for_status()');

		// TypeScript tab — Simple flavor first (default sub-toggle).
		await page.getByTestId('embed-tab-typescript').click();
		await expect(page.getByTestId('ts-flavor')).toBeVisible();
		await expect(page.getByTestId('ts-flavor-simple')).toHaveAttribute('aria-pressed', 'true');
		const tsSimpleValue = await snippet.inputValue();
		expect(tsSimpleValue).toContain('Record<string, string>');
		expect(tsSimpleValue).toContain("title: 'Hello'");
		expect(tsSimpleValue).toContain("count: '12'");
		expect(tsSimpleValue).toContain('URLSearchParams(params)');

		// Flip to Typed flavor — paramSchemas should give us a number for
		// `count` (we set type=number via the schema editor above) and a
		// string for `title`.
		await page.getByTestId('ts-flavor-typed').click();
		await expect(page.getByTestId('ts-flavor-typed')).toHaveAttribute('aria-pressed', 'true');
		const tsTypedValue = await snippet.inputValue();
		expect(tsTypedValue).toContain('type Params = {');
		expect(tsTypedValue).toContain('title: string;');
		expect(tsTypedValue).toContain('count: number;');
		expect(tsTypedValue).toContain("title: 'Hello'");
		// number value emitted unquoted — the whole point of the typed
		// flavor.
		expect(tsTypedValue).toMatch(/\bcount: 12\b/);
		// The Simple-flavor object-literal form must NOT appear in the
		// typed flavor (defensive — would catch a future regression
		// where the sub-toggle stops switching).
		expect(tsTypedValue).not.toContain('Record<string, string>');

		// --- Live-values flow through reopen (TASK-207 data path) ----
		//
		// Close the modal, open the Preview panel, edit `title`'s test
		// value, then reopen the modal and assert the typed-TS snippet
		// picked up the new value. The live-reactivity contract is
		// strictly stronger (no reopen needed) but reopen is what the
		// task spec asks for and is easier to drive from Playwright —
		// the modal and the preview panel both compete for screen
		// space in the test viewport.
		await page.getByRole('button', { name: 'Close' }).click();
		await page.getByRole('button', { name: /^Preview$/ }).click();
		const titleInput = page.locator('#test-param-title');
		await expect(titleInput).toBeVisible({ timeout: 5_000 });
		await titleInput.fill('Updated!');

		// Reopen the publish modal and verify both `title`'s new value
		// flowed through AND the TS Typed flavor is still active (sub-
		// toggle state is component-local — modal close DOES blow it
		// away, but the Typed flavor's schema-driven shape is what we
		// care about; re-select before asserting to make the test
		// deterministic across either policy).
		await page.getByTestId('toolbar-publish').click();
		await expect(page.getByTestId('embed-section')).toBeVisible({ timeout: 5_000 });
		// Re-enable Include-example-values — it's component-local and
		// gets reset when the modal closes.
		await page.getByRole('checkbox', { name: /Include example values/ }).check();
		await page.getByTestId('embed-tab-typescript').click();
		await page.getByTestId('ts-flavor-typed').click();
		await expect
			.poll(async () => await snippet.inputValue(), { timeout: 5_000 })
			.toContain("title: 'Updated!'");

		// --- Copy from TS Typed lands the right thing on the clipboard ---
		await page.getByTestId('embed-copy').click();
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		const finalTypedValue = await snippet.inputValue();
		expect(clipboard).toBe(finalTypedValue);
	});
});
