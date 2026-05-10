/**
 * canvasParams validation. Schema rows are auto-derived from bindings
 * on save; user marks `required` and `type` via the publish modal.
 *
 * As of TASK-94 the public render endpoint is *lenient* by default:
 *   - Missing required param → 200 with `Canvas-Param-Warnings: <name>`,
 *     rendered using the published default (or empty string).
 *   - Type-mismatched value → 200 with the same warning header,
 *     rendered using the default (or empty string).
 *   - `?_strict=1` opts back into the legacy 400 JSON behavior — for
 *     API integrators wiring up validation logic.
 *
 * The lenient default keeps social-card previews working: Twitter /
 * Bluesky / Telegram / Discord all silently drop cards on 400, and
 * the failure mode of "tweet your share URL → no card" is the worst
 * possible UX. Strict callers opt in.
 */
import { test, expect } from '@playwright/test';
import {
	signupAndLogin,
	createCanvas,
	gotoEditor,
	addTextLayer,
	bindParam,
	publish,
	uniqueXffHeaders
} from './helpers';

test.describe('Param validation', () => {
	test('required param missing → lenient default renders 200 with warning header', async ({
		page
	}) => {
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Required title', preset: 'OG / Twitter' });
		await gotoEditor(page, canvas.id);

		// Bind text → ?title= (no default), then publish.
		await addTextLayer(page, 'placeholder');
		await bindParam(page, 'Text Content', 'title');
		const { imageUrl } = await publish(page);

		// Mark as required via the publish modal.
		const requiredBox = page.getByRole('checkbox', { name: 'Required title' });
		await expect(requiredBox).toBeVisible({ timeout: 10_000 });
		await requiredBox.check();

		// Wait for the PATCH to settle. Polling the /params endpoint is
		// the deterministic signal — checkbox state is local until the
		// API confirms.
		await expect(async () => {
			const r = await request.get(`/api/canvas/${canvas.id}/params`);
			const rows = (await r.json()) as { name: string; required: boolean }[];
			expect(rows.find((p) => p.name === 'title')?.required).toBe(true);
		}).toPass({ timeout: 5_000 });

		const xff = uniqueXffHeaders();
		// 1. With param → 200 PNG, no warning header.
		const ok = await request.get(`${imageUrl}?title=Hello`, { headers: xff });
		expect(ok.status()).toBe(200);
		expect(ok.headers()['content-type']).toBe('image/png');
		expect(ok.headers()['canvas-param-warnings']).toBeUndefined();

		// 2. Missing required → 200 PNG with warning header (lenient).
		const lenient = await request.get(imageUrl, { headers: uniqueXffHeaders() });
		expect(lenient.status()).toBe(200);
		expect(lenient.headers()['content-type']).toBe('image/png');
		expect(lenient.headers()['canvas-param-warnings']).toBe('title');

		// 3. ?_strict=1 → 400 JSON (the legacy strict behavior).
		const strict = await request.get(`${imageUrl}?_strict=1`, { headers: uniqueXffHeaders() });
		expect(strict.status()).toBe(400);
		expect(strict.headers()['content-type']).toContain('application/json');
		const body = (await strict.json()) as { error: string; field: string; message: string };
		expect(body.error).toBe('invalid_param');
		expect(body.field).toBe('title');
		expect(body.message).toMatch(/missing|required/i);
	});

	test('type=number on non-numeric: lenient renders 200 with warning, ?_strict=1 → 400', async ({
		page
	}) => {
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Numeric type', preset: 'OG / Twitter' });
		await gotoEditor(page, canvas.id);
		await addTextLayer(page, 'placeholder');
		await bindParam(page, 'Text Content', 'price', '0');
		const { imageUrl } = await publish(page);

		const typeSelect = page.getByLabel('Type for price');
		await expect(typeSelect).toBeVisible({ timeout: 10_000 });
		await typeSelect.selectOption('number');
		await expect(async () => {
			const r = await request.get(`/api/canvas/${canvas.id}/params`);
			const rows = (await r.json()) as { name: string; type: string }[];
			expect(rows.find((p) => p.name === 'price')?.type).toBe('number');
		}).toPass({ timeout: 5_000 });

		const xff = uniqueXffHeaders();
		// Numeric value → 200, no warning.
		const ok = await request.get(`${imageUrl}?price=1234.56`, { headers: xff });
		expect(ok.status()).toBe(200);
		expect(ok.headers()['canvas-param-warnings']).toBeUndefined();

		// Non-numeric (lenient default) → 200 with warning header,
		// renders the published default of '0' instead.
		const lenient = await request.get(`${imageUrl}?price=hello`, { headers: uniqueXffHeaders() });
		expect(lenient.status()).toBe(200);
		expect(lenient.headers()['content-type']).toBe('image/png');
		expect(lenient.headers()['canvas-param-warnings']).toBe('price');

		// Non-numeric with ?_strict=1 → 400 JSON.
		const strict = await request.get(`${imageUrl}?price=hello&_strict=1`, {
			headers: uniqueXffHeaders()
		});
		expect(strict.status()).toBe(400);
		const body = (await strict.json()) as { field: string; message: string };
		expect(body.field).toBe('price');
		expect(body.message).toMatch(/expected a number/i);
	});

	test('required param missing with default still emits Canvas-Param-Warnings (Codex round 1)', async ({
		page
	}) => {
		// Codex round 1 P2: a required param with a default fell through
		// silently — the default was applied, no warning header emitted.
		// The lenient contract says missing-required is observable
		// regardless of whether a default exists. Anyone debugging
		// "why does my card render the generic default?" needs the
		// header to find out.
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, { name: 'Required defaulted', preset: 'OG / Twitter' });
		await gotoEditor(page, canvas.id);
		await addTextLayer(page, 'placeholder');
		await bindParam(page, 'Text Content', 'title', 'Hello fallback');
		const { imageUrl } = await publish(page);

		const requiredBox = page.getByRole('checkbox', { name: 'Required title' });
		await expect(requiredBox).toBeVisible({ timeout: 10_000 });
		await requiredBox.check();
		await expect(async () => {
			const r = await request.get(`/api/canvas/${canvas.id}/params`);
			const rows = (await r.json()) as { name: string; required: boolean }[];
			expect(rows.find((p) => p.name === 'title')?.required).toBe(true);
		}).toPass({ timeout: 5_000 });

		const lenient = await request.get(imageUrl, { headers: uniqueXffHeaders() });
		expect(lenient.status()).toBe(200);
		expect(lenient.headers()['canvas-param-warnings']).toBe('title');
	});

	test('lenient mode aggregates multiple warnings into a single header', async ({ page }) => {
		// Two missing required params → one Canvas-Param-Warnings header
		// listing both, comma-separated. Drive the editor via the
		// templateJson PATCH directly — bindParam(...) can't reliably
		// pick the right "Content" textbox when two text layers exist
		// at once, and the goal of this test is the response header,
		// not the editor UI.
		const request = page.request;
		await signupAndLogin(page);
		const canvas = await createCanvas(page, {
			name: 'Multi required',
			preset: 'OG / Twitter'
		});
		// Synthesize a template with two bound text layers.
		const templateJson = {
			version: '1.0',
			objects: [
				{
					type: 'textbox',
					text: 'placeholder one',
					left: 10,
					top: 10,
					width: 200,
					height: 50,
					paramBindings: { text: { param: 'first' } }
				},
				{
					type: 'textbox',
					text: 'placeholder two',
					left: 10,
					top: 80,
					width: 200,
					height: 50,
					paramBindings: { text: { param: 'second' } }
				}
			]
		};
		await request.patch(`/api/canvas/${canvas.id}`, {
			data: { templateJson, published: true }
		});
		await request.patch(`/api/canvas/${canvas.id}`, {
			data: {
				params: [
					{ name: 'first', required: true },
					{ name: 'second', required: true }
				]
			}
		});

		const imageUrl = `/c/${canvas.id ? '' : ''}`; // placeholder; we'll fetch via slug
		// Re-read the canvas to get the slug (not surfaced from createCanvas).
		const list = await request.get('/api/canvas');
		const canvases = (await list.json()) as Array<{ id: string; slug: string }>;
		const slug = canvases.find((c) => c.id === canvas.id)!.slug;
		const url = `/c/${slug}/image.png`;
		void imageUrl;

		const lenient = await request.get(url, { headers: uniqueXffHeaders() });
		expect(lenient.status()).toBe(200);
		const warnings = lenient.headers()['canvas-param-warnings'];
		expect(warnings).toBeDefined();
		// Order matches def ordering, but be permissive for stability.
		const fields = (warnings || '').split(',').map((s) => s.trim());
		expect(new Set(fields)).toEqual(new Set(['first', 'second']));
	});
});
