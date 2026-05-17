/**
 * Short-ID generator for the `/i/{shortId}` permalink scheme.
 *
 * nanoid(10) over the default 64-char URL-safe alphabet gives ~60 bits of
 * entropy — more than enough for a per-user namespace and short enough
 * to copy/paste comfortably onto a social share. The DB enforces a
 * UNIQUE constraint on `rendered_images.short_id`, so collisions surface
 * as an insert failure and the retry loop simply re-rolls.
 */
import { customAlphabet } from 'nanoid';

/** URL-safe alphabet matching nanoid's default. Kept explicit so the
 *  contract is auditable and stable across nanoid upgrades. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';

/** Length of a generated short-id in chars. Mirrors the DB column's
 *  practical width — 10 chars × 64 alphabet ≈ 1.15 × 10^18 keyspace,
 *  collision-free at any realistic v0.5 scale. */
const ID_LENGTH = 10;

const generator = customAlphabet(ALPHABET, ID_LENGTH);

/** Generate one fresh short id. Never returns the empty string. */
export function generateShortId(): string {
	return generator();
}

/**
 * Repeatedly call `attempt(id)` with fresh short ids until the closure
 * resolves successfully, or the retry cap is reached.
 *
 * `attempt` is expected to throw on `short_id` collision (typically a
 * Postgres unique-violation from `INSERT … RETURNING`); the caller can
 * inspect the wrapped error via the `isCollision` predicate to decide
 * whether to keep retrying. Any non-collision error bubbles immediately.
 *
 * Defaults to 5 attempts — collision probability for nanoid(10) is so
 * low that hitting the cap means something else is wrong (e.g. a
 * mid-test seed accidentally inserting fixed values).
 */
export async function withUniqueShortId<T>(
	attempt: (shortId: string) => Promise<T>,
	options: {
		maxAttempts?: number;
		isCollision?: (err: unknown) => boolean;
	} = {}
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? 5;
	const isCollision =
		options.isCollision ??
		((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			return msg.includes('rendered_images_short_id_unique');
		});
	let lastError: unknown;
	for (let i = 0; i < maxAttempts; i++) {
		try {
			return await attempt(generateShortId());
		} catch (err) {
			if (!isCollision(err)) throw err;
			lastError = err;
		}
	}
	throw lastError ?? new Error('Could not allocate a unique shortId');
}
