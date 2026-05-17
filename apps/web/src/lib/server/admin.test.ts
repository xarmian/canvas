import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We have to mock the SvelteKit env module BEFORE importing `admin.ts`
// so the cached `env` reference picks up our stub. Vitest's `vi.mock`
// is hoisted, so this works even though the import appears below.
vi.mock('$env/dynamic/private', () => ({
	env: {}
}));

import { env } from '$env/dynamic/private';
import { isAdmin } from './admin';

describe('isAdmin', () => {
	const envWrite = env as Record<string, string | undefined>;

	beforeEach(() => {
		delete envWrite.CANVAS_ADMIN_EMAILS;
	});

	afterEach(() => {
		delete envWrite.CANVAS_ADMIN_EMAILS;
	});

	it('returns false when the env var is unset (fresh-install posture)', () => {
		expect(isAdmin({ email: 'someone@example.com' })).toBe(false);
	});

	it('returns false when the env var is empty', () => {
		envWrite.CANVAS_ADMIN_EMAILS = '';
		expect(isAdmin({ email: 'someone@example.com' })).toBe(false);
	});

	it('returns false for null / undefined users', () => {
		envWrite.CANVAS_ADMIN_EMAILS = 'a@b.com';
		expect(isAdmin(null)).toBe(false);
		expect(isAdmin(undefined)).toBe(false);
	});

	it('matches a single allowlisted email', () => {
		envWrite.CANVAS_ADMIN_EMAILS = 'admin@example.com';
		expect(isAdmin({ email: 'admin@example.com' })).toBe(true);
	});

	it('matches case-insensitively', () => {
		envWrite.CANVAS_ADMIN_EMAILS = 'Admin@Example.COM';
		expect(isAdmin({ email: 'admin@example.com' })).toBe(true);
		expect(isAdmin({ email: 'ADMIN@EXAMPLE.COM' })).toBe(true);
	});

	it('matches one of many comma-separated entries', () => {
		envWrite.CANVAS_ADMIN_EMAILS = 'a@b.com, c@d.com ,e@f.com';
		expect(isAdmin({ email: 'c@d.com' })).toBe(true);
		expect(isAdmin({ email: 'x@y.com' })).toBe(false);
	});

	it('ignores blank entries in the comma list', () => {
		envWrite.CANVAS_ADMIN_EMAILS = 'a@b.com,,';
		expect(isAdmin({ email: 'a@b.com' })).toBe(true);
		// An empty string in the list shouldn't match an empty user email.
		expect(isAdmin({ email: '' })).toBe(false);
	});
});
