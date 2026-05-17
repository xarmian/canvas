/**
 * Publish-flow embed modal (TASK-69). Verifies the embed-snippet
 * section appears after publish, tabs swap snippets, and Copy
 * writes a valid <img> tag for HTML / Markdown / OG meta.
 */
import { test, expect } from '@playwright/test';
import { signupAndLogin, createCanvas, publish } from './helpers';

test.describe('Publish embed modal', () => {
	test('embed snippets cover html/markdown/og/url/curl with copyable values', async ({
		page,
		context
	}) => {
		// Grant clipboard permissions so we can verify Copy works.
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);

		await signupAndLogin(page);
		const canvas = await createCanvas(page);
		const { imageUrl } = await publish(page);

		// Embed section is visible alongside the existing Share + Image URL fields.
		const embedSection = page.getByTestId('embed-section');
		await expect(embedSection).toBeVisible();

		// HTML tab is the default.
		const snippet = page.getByTestId('embed-snippet');
		await expect(snippet).toBeVisible();
		const htmlValue = await snippet.inputValue();
		expect(htmlValue).toMatch(
			/^<img src="[^"]+image\.png[^"]*" alt="[^"]+" width="\d+" height="\d+" \/>/
		);
		expect(htmlValue).toContain(imageUrl);

		// Switch to Markdown.
		await page.getByTestId('embed-tab-markdown').click();
		const mdValue = await snippet.inputValue();
		expect(mdValue).toMatch(/^!\[Canvas: [^\]]+\]\([^)]+\)$/);
		expect(mdValue).toContain(imageUrl);

		// Switch to OG meta — three lines with og:image, og:image:width, og:image:height.
		await page.getByTestId('embed-tab-og').click();
		const ogValue = await snippet.inputValue();
		expect(ogValue).toContain('property="og:image"');
		expect(ogValue).toContain('og:image:width');
		expect(ogValue).toContain('og:image:height');

		// Switch to Plain URL — the value is the URL itself.
		await page.getByTestId('embed-tab-url').click();
		const urlValue = await snippet.inputValue();
		expect(urlValue).toContain(imageUrl);

		// Switch to cURL.
		await page.getByTestId('embed-tab-curl').click();
		const curlValue = await snippet.inputValue();
		expect(curlValue).toMatch(/^curl -o canvas\.png '/);

		// Copy from the active (cURL) tab and verify clipboard.
		await page.getByTestId('embed-copy').click();
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toBe(curlValue);

		// Confirm the canvas id was used to look up its version token —
		// after a brief wait, the snippet should include _v=<token>.
		await expect
			.poll(async () => {
				await page.getByTestId('embed-tab-url').click();
				return await snippet.inputValue();
			})
			.toContain('_v=');

		// Sanity: canvas was returned with a non-empty id.
		expect(canvas.id).toBeTruthy();
	});
});
