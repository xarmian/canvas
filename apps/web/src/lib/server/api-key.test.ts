import { describe, it, expect } from 'vitest';
import { TOKEN_PREFIX, extractPrefix, generateApiKey, verifyToken } from './api-key';

// NOTE: `authenticateBearer` round-trips through the database and is
// exercised by Playwright integration tests in `e2e/` rather than vitest —
// mocking out drizzle here would just re-test the mock. These unit tests
// cover the pure (DB-free) building blocks.

describe('generateApiKey', () => {
	it('produces a token with the ck_live_ prefix', async () => {
		const { token } = await generateApiKey();
		expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
	});

	it('produces a token of at least 32 chars after the prefix', async () => {
		const { token } = await generateApiKey();
		expect(token.length).toBeGreaterThanOrEqual(TOKEN_PREFIX.length + 32);
	});

	it('produces a hashedSecret that argon2-verifies against the plaintext token', async () => {
		const { token, hashedSecret } = await generateApiKey();
		expect(await verifyToken(token, hashedSecret)).toBe(true);
	});

	it('returns prefix = first 12 chars of the token', async () => {
		const { token, prefix } = await generateApiKey();
		expect(prefix).toBe(token.slice(0, 12));
		expect(prefix.startsWith(TOKEN_PREFIX)).toBe(true);
	});

	it('produces unique tokens on each call', async () => {
		const a = await generateApiKey();
		const b = await generateApiKey();
		expect(a.token).not.toBe(b.token);
		expect(a.hashedSecret).not.toBe(b.hashedSecret);
	});
});

describe('extractPrefix', () => {
	it('returns the first 12 chars of a normal token', () => {
		expect(extractPrefix('ck_live_abcdefghijklmnop')).toBe('ck_live_abcd');
	});

	it('returns the input unchanged when shorter than 12 chars', () => {
		expect(extractPrefix('ck_live_')).toBe('ck_live_');
	});

	it('returns the empty string for the empty input', () => {
		expect(extractPrefix('')).toBe('');
	});
});

describe('verifyToken', () => {
	it('returns true for a matching token / hash pair', async () => {
		const { token, hashedSecret } = await generateApiKey();
		expect(await verifyToken(token, hashedSecret)).toBe(true);
	});

	it('returns false when the token does not match the hash', async () => {
		const { hashedSecret } = await generateApiKey();
		expect(await verifyToken('ck_live_wrong-token-value-9999', hashedSecret)).toBe(false);
	});

	it('returns false (does not throw) for a malformed hash string', async () => {
		expect(await verifyToken('ck_live_anything', 'not-a-valid-argon2-hash')).toBe(false);
	});

	it('returns false for the empty hash', async () => {
		expect(await verifyToken('ck_live_anything', '')).toBe(false);
	});
});
