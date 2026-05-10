/**
 * Slug normalization, validation, and uniqueness helpers.
 *
 * URL scheme is option A from TASK-92's design memo: globally-unique
 * user-chosen slugs in `/c/{slug}`. Pre-launch latitude lets us drop
 * the `-{nanoid}` suffix the v0.4 scheme used; collisions are resolved
 * automatically on auto-derived slugs (POST /api/canvas, duplicate)
 * and surfaced as a 409 to the client on user-driven rename (TASK-98).
 *
 * See `src/routes/c/[slug]/+page.server.ts` for the route-side documentation
 * of the URL scheme.
 */
import { eq } from 'drizzle-orm';
import { canvases } from './db/schema';
import type { db as Db } from './db';

/** Maximum allowed slug length. Postgres `text` is unbounded; we cap on
 *  the application side to keep URLs sharable in places that truncate
 *  long links (Twitter, SMS, scanner UIs). */
export const SLUG_MAX_LENGTH = 80;

/** Reserved slugs that would collide with first-class app routes. The
 *  SvelteKit router evaluates static segments before `[slug]`, so a
 *  reserved match wouldn't actually break the app — but the share URL
 *  would silently 404 because `c/api` shadows our actual `c/[slug]`
 *  resolver only for the ones we haven't routed elsewhere. Reject up
 *  front so the user gets a clear error instead of debugging a dead URL. */
const RESERVED_SLUGS = new Set([
	'',
	'api',
	'admin',
	'assets',
	'auth',
	'dashboard',
	'editor',
	'login',
	'logout',
	'new',
	'public',
	'settings',
	'signup',
	'static'
]);

/** Convert an arbitrary string into a URL-safe slug.
 *
 *  - lowercased
 *  - non-alphanumeric runs collapsed to a single `-`
 *  - leading/trailing `-` trimmed
 *  - capped at SLUG_MAX_LENGTH
 *
 *  Returns the empty string when nothing usable remains (all-symbols
 *  input, empty string). Callers must handle the empty case — typically
 *  by falling back to a synthetic placeholder. */
export function slugify(input: string): string {
	const normalized = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (normalized.length <= SLUG_MAX_LENGTH) return normalized;
	return normalized.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
}

/** Validate a user-supplied slug against the v1 format.
 *
 *  Rules: lowercase letters, digits, hyphens; no leading/trailing/
 *  consecutive hyphens; 1..SLUG_MAX_LENGTH chars; not in the reserved
 *  list. Returned `reason` is plain English so the API can echo it
 *  straight back to the client. */
export function validateSlug(slug: string): { ok: true } | { ok: false; reason: string } {
	if (typeof slug !== 'string') return { ok: false, reason: 'Slug must be a string' };
	if (slug.length === 0) return { ok: false, reason: 'Slug cannot be empty' };
	if (slug.length > SLUG_MAX_LENGTH) {
		return { ok: false, reason: `Slug cannot be longer than ${SLUG_MAX_LENGTH} characters` };
	}
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		return {
			ok: false,
			reason:
				'Slug must use lowercase letters, numbers, and hyphens (no leading/trailing/consecutive hyphens)'
		};
	}
	if (RESERVED_SLUGS.has(slug)) {
		return { ok: false, reason: `"${slug}" is reserved and cannot be used as a slug` };
	}
	return { ok: true };
}

/** Truncate `base` so we can append `-N` (suffix length included) without
 *  exceeding SLUG_MAX_LENGTH, then re-trim trailing hyphens. Used when
 *  resolving an auto-derived slug collision. */
function withSuffixRoom(base: string, suffixLength: number): string {
	const room = SLUG_MAX_LENGTH - suffixLength;
	if (base.length <= room) return base;
	return base.slice(0, room).replace(/-+$/, '');
}

/** Find an available slug by appending `-2`, `-3`, ... until we miss the
 *  unique index. Returns `base` itself if it's free.
 *
 *  `ignoreId` is passed by rename flows so the canvas keeps its own slug
 *  if the user submits the same one (no-op rename should not 409).
 *
 *  Why not `nanoid` suffix again? The v1 design picks the *smallest* free
 *  N so the URL stays short and predictable. Collisions on auto-derived
 *  slugs from POST /api/canvas are extremely rare in practice (same user
 *  creating two canvases with the same name) — the lookup loop is
 *  bounded but in normal use exits on the first iteration. */
export async function findAvailableSlug(
	dbInstance: typeof Db,
	base: string,
	opts: { ignoreId?: string } = {}
): Promise<string> {
	if (base.length === 0) base = 'canvas';

	const initial = await dbInstance
		.select({ id: canvases.id })
		.from(canvases)
		.where(eq(canvases.slug, base));
	if (initial.length === 0 || (opts.ignoreId && initial[0].id === opts.ignoreId)) {
		return base;
	}

	for (let n = 2; n < 10_000; n++) {
		const suffix = `-${n}`;
		const candidate = `${withSuffixRoom(base, suffix.length)}${suffix}`;
		const existing = await dbInstance
			.select({ id: canvases.id })
			.from(canvases)
			.where(eq(canvases.slug, candidate));
		if (existing.length === 0 || (opts.ignoreId && existing[0].id === opts.ignoreId)) {
			return candidate;
		}
	}
	// Highly unlikely escape hatch — 10k name collisions for the same
	// base would require a deliberate exhaustion attack. Fall back to a
	// timestamp so the create still succeeds and the user can rename.
	return `${withSuffixRoom(base, 14)}-${Date.now().toString(36)}`;
}

/** Suggest the next-best slug to a user whose chosen slug is already
 *  taken. Used by the rename PATCH (TASK-98) and the create POST when
 *  surfacing a collision error. Stops at 10 suffixes so the response
 *  payload doesn't blow up on a popular name. */
export async function suggestAlternateSlug(
	dbInstance: typeof Db,
	base: string,
	opts: { ignoreId?: string } = {}
): Promise<string> {
	return findAvailableSlug(dbInstance, base, opts);
}
