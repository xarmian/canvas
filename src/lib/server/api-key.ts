/**
 * API key generation, hashing, and bearer-token authentication.
 *
 * Tokens are formatted as `ck_live_<base64url(24 bytes)>` — ~32 chars after
 * the prefix, ~192 bits of entropy. The plaintext is shown to the user ONCE
 * at creation; only the argon2id hash is stored in the database.
 *
 * Lookup strategy: `prefix` (the non-secret first 12 chars) is unique and
 * indexed, so the auth path narrows by a single equality lookup, then
 * argon2-verifies against the candidate's `hashedSecret`. Constant-time
 * comparison is handled by argon2 itself.
 *
 * Per TASK-166: hooks.server.ts wires bearer-token recognition AFTER the
 * existing Better Auth session lookup, so session cookies take precedence.
 * Invalid tokens fall through silently (no 401 here) — the public
 * `/c/{slug}` render path must remain anonymous-reachable. Downstream
 * `/api/v1/*` routes call `requireApiKey()` and return 401 / 403 themselves.
 */
import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { eq, isNull, and } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { User } from 'better-auth';
import { db } from './db';
import { apiKeys, user as userTable } from './db/schema';

/** Stable prefix for live (non-test) tokens. Used both for the visible token
 *  format and for the indexed-narrowing lookup on the auth path. */
export const TOKEN_PREFIX = 'ck_live_';

/** First 12 chars of a token — `ck_live_` (8 chars) + 4 random chars.
 *  Long enough to disambiguate keys in the UI, short enough not to leak
 *  material. Mirrors the column constraint in `api_keys.prefix`. */
const PREFIX_LENGTH = 12;

/** Bytes of entropy embedded in the random portion of a token. 24 bytes
 *  → 32 base64url chars → ~192 bits, well past collision concerns even at
 *  internet scale. */
const SECRET_BYTES = 24;

/** Generate a fresh `ck_live_*` bearer token plus the values to persist.
 *  Caller is responsible for inserting `{ prefix, hashedSecret }` into
 *  `api_keys` and returning `token` to the user exactly once. */
export async function generateApiKey(): Promise<{
	token: string;
	prefix: string;
	hashedSecret: string;
}> {
	const secret = randomBytes(SECRET_BYTES).toString('base64url');
	const token = `${TOKEN_PREFIX}${secret}`;
	const prefix = extractPrefix(token);
	const hashedSecret = await hash(token);
	return { token, prefix, hashedSecret };
}

/** Return the first 12 chars of a token — `ck_live_xxxx`. Tokens shorter
 *  than 12 chars are returned as-is; the auth path treats those as
 *  "unknown prefix → no match" downstream. */
export function extractPrefix(token: string): string {
	return token.slice(0, PREFIX_LENGTH);
}

/** Verify a candidate plaintext token against a stored argon2id hash.
 *  Returns false (never throws) on malformed hashes so callers don't need
 *  to defensively catch — a corrupt row is treated as a non-match. */
export async function verifyToken(token: string, hashedSecret: string): Promise<boolean> {
	try {
		return await verify(hashedSecret, token);
	} catch {
		return false;
	}
}

export type AuthenticatedApiKey = {
	id: string;
	userId: string;
	scopes: string[];
};

/**
 * Look up a bearer token. Returns the apiKey row + owning user on success,
 * or `null` for any failure mode (unknown prefix, revoked key, hash
 * mismatch, garbage input). Never throws.
 *
 * Side effect on success: `lastUsedAt` is bumped via a fire-and-forget
 * `setImmediate` so the auth path stays off the write hot path. If the
 * write fails (e.g. brief DB hiccup), the next successful auth will
 * re-write the timestamp.
 */
export async function authenticateBearer(
	token: string
): Promise<{ apiKey: AuthenticatedApiKey; user: User } | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const prefix = extractPrefix(token);
	if (prefix.length < PREFIX_LENGTH) return null;

	// Single narrow lookup by indexed prefix; the partial-match candidate is
	// then argon2-verified below. Revoked keys are filtered server-side so
	// they never enter the verify path.
	const [row] = await db
		.select({
			id: apiKeys.id,
			userId: apiKeys.userId,
			scopes: apiKeys.scopes,
			hashedSecret: apiKeys.hashedSecret
		})
		.from(apiKeys)
		.where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
		.limit(1);
	if (!row) return null;

	const valid = await verifyToken(token, row.hashedSecret);
	if (!valid) return null;

	const [u] = await db.select().from(userTable).where(eq(userTable.id, row.userId)).limit(1);
	if (!u) return null;

	const apiKeyId = row.id;
	// Fire-and-forget; never block the request on the lastUsedAt write.
	setImmediate(() => {
		db.update(apiKeys)
			.set({ lastUsedAt: new Date() })
			.where(eq(apiKeys.id, apiKeyId))
			.catch((err) => {
				console.warn(`[api-key] lastUsedAt update failed id=${apiKeyId}`, err);
			});
	});

	return {
		apiKey: { id: row.id, userId: row.userId, scopes: row.scopes },
		// Cast: the `user` table columns match the Better Auth `User` shape; the
		// session-cookie path uses the same row.
		user: u as unknown as User
	};
}

/**
 * Route-handler guard. Returns the apiKey if present and scoped; otherwise
 * throws a SvelteKit `HttpError` with the right status. Routes should call
 * this at the top of `POST` / `GET` / `DELETE` for `/api/v1/*` endpoints.
 *
 * IMPORTANT (Codex review round 1, P1): we throw via SvelteKit's `error()`
 * helper — plain `Error` instances with a `status` property are NOT
 * preserved by SvelteKit's error handler and surface as 500s, defeating
 * the 401 / 403 contract.
 */
export function requireApiKey(locals: App.Locals, requiredScope: string): AuthenticatedApiKey {
	if (!locals.apiKey) {
		error(401, 'Unauthorized');
	}
	if (!locals.apiKey.scopes.includes(requiredScope)) {
		error(403, `Missing scope: ${requiredScope}`);
	}
	return locals.apiKey;
}
