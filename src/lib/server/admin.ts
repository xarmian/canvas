/**
 * Instance-admin allowlist.
 *
 * Admins are identified by email (case-insensitive) via the
 * `CANVAS_ADMIN_EMAILS` env var — a comma-separated list. Empty (the
 * default) means "no admins" — admin routes 403 for every user including
 * the only one. That posture is deliberate for fresh self-host
 * installs: the operator opts in explicitly by setting the env, so a
 * compromised user account on a defaultsfresh install can't reach the
 * admin surface.
 *
 * This is a v1 single-process check. A future admin-role model on the
 * user table (IDEA-59) replaces this without changing route call sites.
 */
import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';

function parseAdminList(): Set<string> {
	const raw = (env as Record<string, string | undefined>).CANVAS_ADMIN_EMAILS ?? '';
	const list = raw
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return new Set(list);
}

export function isAdmin(user: { email: string } | null | undefined): boolean {
	if (!user || !user.email) return false;
	return parseAdminList().has(user.email.toLowerCase());
}

/** Route-guard helper. Throws a styled SvelteKit error so the response
 *  goes through the app's `+error.svelte` rather than the bare default. */
export function requireAdmin(user: { email: string } | null | undefined): void {
	if (!isAdmin(user)) error(403, 'Forbidden');
}
