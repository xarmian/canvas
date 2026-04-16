import { test, expect } from '@playwright/test';

/**
 * Canvas MVP E2E tests — API-based for CI compatibility.
 * Tests the full user flow via HTTP requests without requiring a browser.
 */

test.describe('Canvas MVP E2E', () => {
	test.describe('Auth flow', () => {
		test('sign up returns user and session', async ({ request }) => {
			const res = await request.post('/api/auth/sign-up/email', {
				data: {
					name: 'Auth Tester',
					email: `auth-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});
			expect(res.status()).toBe(200);
			const body = await res.json();
			expect(body.user.name).toBe('Auth Tester');
			expect(body.token).toBeTruthy();
		});

		test('sign up creates user with correct name', async ({ request }) => {
			const email = `signup2-${Date.now()}@test.com`;
			const res = await request.post('/api/auth/sign-up/email', {
				data: { name: 'Name Check', email, password: 'testpass123456' }
			});
			expect(res.status()).toBe(200);
			const body = await res.json();
			expect(body.user.name).toBe('Name Check');
			expect(body.user.email).toBe(email);
		});

		test('unauthenticated API access returns 401', async ({ request }) => {
			const res = await request.get('/api/canvas');
			expect(res.status()).toBe(401);
		});
	});

	test.describe('Canvas CRUD', () => {
		let cookies: string;
		const email = `crud-${Date.now()}@test.com`;

		test.beforeAll(async ({ request }) => {
			const res = await request.post('/api/auth/sign-up/email', {
				data: { name: 'CRUD Tester', email, password: 'testpass123456' }
			});
			cookies = res.headers()['set-cookie'] || '';
		});

		test('create canvas', async ({ request }) => {
			const res = await request.post('/api/canvas', {
				data: { name: 'Test Canvas', width: 1200, height: 630 },
				headers: { cookie: cookies }
			});
			expect(res.status()).toBe(201);
			const canvas = await res.json();
			expect(canvas.name).toBe('Test Canvas');
			expect(canvas.slug).toBeTruthy();
			expect(canvas.width).toBe(1200);
			expect(canvas.height).toBe(630);
		});

		test('list canvases', async ({ request }) => {
			const res = await request.get('/api/canvas', {
				headers: { cookie: cookies }
			});
			expect(res.status()).toBe(200);
			const list = await res.json();
			expect(list.length).toBeGreaterThan(0);
		});

		test('update canvas', async ({ request }) => {
			// Get canvas list
			const listRes = await request.get('/api/canvas', {
				headers: { cookie: cookies }
			});
			const [canvas] = await listRes.json();

			// Update
			const res = await request.patch(`/api/canvas/${canvas.id}`, {
				data: {
					name: 'Updated Canvas',
					templateJson: { version: '1.0', objects: [{ type: 'textbox', text: 'Hello' }] }
				},
				headers: { cookie: cookies }
			});
			expect(res.status()).toBe(200);
			const updated = await res.json();
			expect(updated.name).toBe('Updated Canvas');
		});

		test('delete canvas', async ({ request }) => {
			// Create a canvas to delete
			const createRes = await request.post('/api/canvas', {
				data: { name: 'To Delete' },
				headers: { cookie: cookies }
			});
			const canvas = await createRes.json();

			const res = await request.delete(`/api/canvas/${canvas.id}`, {
				headers: { cookie: cookies }
			});
			expect(res.status()).toBe(200);

			// Verify it's gone
			const getRes = await request.get(`/api/canvas/${canvas.id}`, {
				headers: { cookie: cookies }
			});
			expect(getRes.status()).toBe(404);
		});
	});

	test.describe('Public rendering', () => {
		test('unpublished canvas returns 404', async ({ request }) => {
			const res = await request.get('/c/nonexistent-slug/image.png');
			expect(res.status()).toBe(404);
		});

		test('published canvas renders PNG', async ({ request }) => {
			const signupRes = await request.post('/api/auth/sign-up/email', {
				data: {
					name: 'Render Tester',
					email: `render-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});
			const cookies = signupRes.headers()['set-cookie'] || '';

			const createRes = await request.post('/api/canvas', {
				data: {
					name: 'Render Test',
					width: 1200,
					height: 630,
					backgroundType: 'color',
					backgroundValue: '#ff0000'
				},
				headers: { cookie: cookies }
			});
			const canvas = await createRes.json();

			await request.patch(`/api/canvas/${canvas.id}`, {
				data: { published: true },
				headers: { cookie: cookies }
			});

			const imgRes = await request.get(`/c/${canvas.slug}/image.png`);
			expect(imgRes.status()).toBe(200);
			expect(imgRes.headers()['content-type']).toBe('image/png');
			expect((await imgRes.body()).length).toBeGreaterThan(100);
		});

		test('format negotiation works (jpg, webp)', async ({ request }) => {
			const signupRes = await request.post('/api/auth/sign-up/email', {
				data: {
					name: 'Format Tester',
					email: `format-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});
			const cookies = signupRes.headers()['set-cookie'] || '';

			const createRes = await request.post('/api/canvas', {
				data: { name: 'Format Test', width: 400, height: 200 },
				headers: { cookie: cookies }
			});
			const canvas = await createRes.json();

			await request.patch(`/api/canvas/${canvas.id}`, {
				data: { published: true },
				headers: { cookie: cookies }
			});

			const jpgRes = await request.get(`/c/${canvas.slug}/image.jpg`);
			expect(jpgRes.status()).toBe(200);
			expect(jpgRes.headers()['content-type']).toBe('image/jpeg');

			const webpRes = await request.get(`/c/${canvas.slug}/image.webp`);
			expect(webpRes.status()).toBe(200);
			expect(webpRes.headers()['content-type']).toBe('image/webp');
		});
	});

	test.describe('Share page + OG tags', () => {
		test('bot receives OG meta tags with param substitution', async ({ request }) => {
			const signupRes = await request.post('/api/auth/sign-up/email', {
				data: {
					name: 'OG Tester',
					email: `og-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});
			const cookies = signupRes.headers()['set-cookie'] || '';

			const createRes = await request.post('/api/canvas', {
				data: { name: 'OG Test', width: 1200, height: 630 },
				headers: { cookie: cookies }
			});
			const canvas = await createRes.json();

			await request.patch(`/api/canvas/${canvas.id}`, {
				data: { published: true, ogTitle: 'Hello {{name}}' },
				headers: { cookie: cookies }
			});

			const shareRes = await request.get(`/c/${canvas.slug}?name=World`, {
				headers: { 'user-agent': 'Twitterbot/1.0' }
			});
			expect(shareRes.status()).toBe(200);
			const html = await shareRes.text();
			expect(html).toContain('og:image');
			expect(html).toContain('Hello World');
			expect(html).toContain('twitter:card');
		});

		test('human with redirect gets 302', async ({ request }) => {
			const signupRes = await request.post('/api/auth/sign-up/email', {
				data: {
					name: 'Redirect Tester',
					email: `redirect-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});
			const cookies = signupRes.headers()['set-cookie'] || '';

			const createRes = await request.post('/api/canvas', {
				data: { name: 'Redirect Test' },
				headers: { cookie: cookies }
			});
			const canvas = await createRes.json();

			await request.patch(`/api/canvas/${canvas.id}`, {
				data: { published: true, redirectUrl: 'https://example.com' },
				headers: { cookie: cookies }
			});

			const res = await request.get(`/c/${canvas.slug}`, {
				maxRedirects: 0
			});
			expect(res.status()).toBe(302);
		});
	});

	test.describe('Access control', () => {
		test("cannot access another user's canvas", async ({ playwright }) => {
			// Use isolated request contexts so cookies don't leak
			const ctxA = await playwright.request.newContext({ baseURL: 'http://localhost:5173' });
			const ctxB = await playwright.request.newContext({ baseURL: 'http://localhost:5173' });

			await ctxA.post('/api/auth/sign-up/email', {
				data: {
					name: 'User A',
					email: `usera-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});

			const createRes = await ctxA.post('/api/canvas', {
				data: { name: 'Private Canvas' }
			});
			const canvas = await createRes.json();

			await ctxB.post('/api/auth/sign-up/email', {
				data: {
					name: 'User B',
					email: `userb-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});

			const getRes = await ctxB.get(`/api/canvas/${canvas.id}`);
			expect(getRes.status()).toBe(404);

			await ctxA.dispose();
			await ctxB.dispose();
		});

		test("cannot update another user's canvas", async ({ playwright }) => {
			const ctxA = await playwright.request.newContext({ baseURL: 'http://localhost:5173' });
			const ctxB = await playwright.request.newContext({ baseURL: 'http://localhost:5173' });

			await ctxA.post('/api/auth/sign-up/email', {
				data: {
					name: 'Owner',
					email: `owner-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});

			const createRes = await ctxA.post('/api/canvas', {
				data: { name: 'Owner Canvas' }
			});
			const canvas = await createRes.json();

			await ctxB.post('/api/auth/sign-up/email', {
				data: {
					name: 'Attacker',
					email: `attacker-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});

			const patchRes = await ctxB.patch(`/api/canvas/${canvas.id}`, {
				data: { name: 'Hacked!' }
			});
			expect(patchRes.status()).toBe(404);

			await ctxA.dispose();
			await ctxB.dispose();
		});
	});

	test.describe('Upload', () => {
		test('unauthenticated upload returns 401', async ({ request }) => {
			const res = await request.post('/api/upload');
			expect(res.status()).toBe(401);
		});

		test('invalid file type returns 400', async ({ request }) => {
			const signupRes = await request.post('/api/auth/sign-up/email', {
				data: {
					name: 'Upload Tester',
					email: `upload-${Date.now()}@test.com`,
					password: 'testpass123456'
				}
			});
			const cookies = signupRes.headers()['set-cookie'] || '';

			const res = await request.post('/api/upload', {
				headers: { cookie: cookies },
				multipart: {
					file: {
						name: 'test.txt',
						mimeType: 'text/plain',
						buffer: Buffer.from('hello')
					}
				}
			});
			expect(res.status()).toBe(400);
		});
	});
});
