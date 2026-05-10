/**
 * Pipe formatter coverage — verifies the renderer applies the binding's
 * `format` to text content and that formatters fall through cleanly when
 * the param value isn't numeric/parseable.
 *
 * The browser test ships only a sanity check (formatter dropdown renders);
 * the bulk of the assertions are API-level since Intl output isn't easy to
 * pixel-diff. Server is the source of truth — same renderer used by both
 * preview and public render endpoints.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, gotoEditor, addTextLayer, bindParam } from './helpers';

test.describe('Pipe formatters', () => {
	test('renderer applies currency formatter to bound text', async ({ page }) => {
		// Use page.request (inherits page cookies) so authenticated endpoints
		// are reachable from the same logged-in session.
		const request = page.request;
		// Build a published canvas with a text layer whose content is bound
		// to ?price= and formatted as currency:USD. The renderer should
		// substitute "$1,234.56" for ?price=1234.56.
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Formatter currency', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);
		await addTextLayer(page, '$0.00');
		await bindParam(page, 'Text Content', 'price', '0');

		// Pick the currency:USD preset from the new dropdown shipped in
		// this task. The select is the only one inside the binding row.
		await page.getByLabel('Format').selectOption('currency:USD');

		// Save + publish via the existing helper paths. We don't need the
		// share URL — read templateJson back from the API instead since the
		// rendered PNG is pixel data we don't introspect here.
		await page.getByRole('button', { name: 'Save' }).click();
		// Save indicator is a span (not a button); wait for the 'saved' label.
		await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });

		const apiRes = await request.get(`/api/canvas/${canvas.id}`);
		expect(apiRes.status()).toBe(200);
		const apiCanvas = (await apiRes.json()) as {
			templateJson: { objects: { paramBindings?: Record<string, { format?: string }> }[] };
		};
		const obj = apiCanvas.templateJson.objects.find((o) => o.paramBindings?.text);
		expect(obj?.paramBindings?.text?.format).toBe('currency:USD');

		// Render via preview endpoint with two values; the bound text would
		// get '$1,234.56' for 1234.56 and '$0.00' for the default. Bytes
		// must differ — same template, different rendered text.
		const a = await request.get(`/api/canvas/${canvas.id}/preview?price=1234.56`);
		const b = await request.get(`/api/canvas/${canvas.id}/preview?price=0`);
		expect(a.status()).toBe(200);
		expect(b.status()).toBe(200);
		expect((await a.body()).equals(await b.body())).toBe(false);
	});

	test('non-numeric input falls through unchanged', async ({ page }) => {
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Formatter fall-through', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);
		await addTextLayer(page, 'placeholder');
		await bindParam(page, 'Text Content', 'value', 'fallback text');
		await page.getByLabel('Format').selectOption('currency:USD');
		await page.getByRole('button', { name: 'Save' }).click();

		// Param=words → not a number → renderer should show the words verbatim
		// rather than blanking the layer. We can't read pixels easily; assert
		// only that the request succeeds and the response is a valid PNG.
		const res = await request.get(`/api/canvas/${canvas.id}/preview?value=hello-world`);
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toBe('image/png');
		expect((await res.body()).length).toBeGreaterThan(100);
	});

	test('compact formatter shrinks large numbers (TASK-88)', async ({ page }) => {
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Compact', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);
		await addTextLayer(page, '0');
		await bindParam(page, 'Text Content', 'mc', '0');

		// `compact` (default = 1 fraction digit) turns 1234567 into "1.2M"
		// — far fewer pixels than the unformatted "1234567". A different
		// formatter on the same param value should render different bytes.
		// (`compact` is semantically `compact:1`; the dropdown ships the
		// default-arg form to match the existing `number` / `number:2`
		// preset shape.)
		await page.getByLabel('Format').selectOption('compact');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });

		// Persistence guard.
		const apiRes = await request.get(`/api/canvas/${canvas.id}`);
		const apiCanvas = (await apiRes.json()) as {
			templateJson: { objects: { paramBindings?: Record<string, { format?: string }> }[] };
		};
		const obj = apiCanvas.templateJson.objects.find((o) => o.paramBindings?.text);
		expect(obj?.paramBindings?.text?.format).toBe('compact');

		// `compact` and `number` of the same input must produce different
		// rendered text — otherwise the formatter was a no-op.
		const compactRender = await request.get(`/api/canvas/${canvas.id}/preview?mc=1234567`);
		expect(compactRender.status()).toBe(200);
		expect((await compactRender.body()).length).toBeGreaterThan(100);

		// Switch to plain number formatter and verify byte-difference. The
		// canvas state is the same; only the param flow changes.
		await page.getByLabel('Format').selectOption('number');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });
		const numberRender = await request.get(`/api/canvas/${canvas.id}/preview?mc=1234567`);
		expect(numberRender.status()).toBe(200);
		expect((await numberRender.body()).equals(await compactRender.body())).toBe(false);
	});

	test('crypto-price digit arg changes precision (TASK-88)', async ({ page }) => {
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Crypto price', preset: 'OG Image' });
		await gotoEditor(page, canvas.id);
		await addTextLayer(page, '$0');
		await bindParam(page, 'Text Content', 'price', '0');

		// Default (4 sig digits) baseline: ?price=0.000123 → "$0.0001230".
		await page.getByLabel('Format').selectOption('crypto-price');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });
		const defaultRender = await request.get(`/api/canvas/${canvas.id}/preview?price=0.000123`);
		expect(defaultRender.status()).toBe(200);
		expect((await defaultRender.body()).length).toBeGreaterThan(100);

		// 6 sig digits: ?price=0.000123 → "$0.00012300" — extra trailing
		// zero, so different rendered bytes than the default-precision render.
		await page.getByLabel('Format').selectOption('crypto-price:6');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 10_000 });
		const sixSigRender = await request.get(`/api/canvas/${canvas.id}/preview?price=0.000123`);
		expect(sixSigRender.status()).toBe(200);
		expect((await sixSigRender.body()).equals(await defaultRender.body())).toBe(false);

		// ≥1 magnitude path: standard currency formatting at 2 fraction
		// digits regardless of sigDigits arg. `?price=1234.56` should
		// render "$1,234.56" — distinct again from the small-number
		// formatting bytes.
		const dollarRender = await request.get(`/api/canvas/${canvas.id}/preview?price=1234.56`);
		expect(dollarRender.status()).toBe(200);
		expect((await dollarRender.body()).equals(await sixSigRender.body())).toBe(false);
		expect((await dollarRender.body()).equals(await defaultRender.body())).toBe(false);
	});
});
