/**
 * POST /api/v1/renders — create a baked render.
 *
 * Bearer-authenticated (`Authorization: Bearer ck_live_*`), scoped to
 * `render:create`. Validates the canvas + params, dedups by
 * `(userId, contentHash)`, renders, persists bytes to storage, writes
 * the row, and returns the short-id permalink.
 *
 * Read-side (GET list, GET / DELETE by shortId) lives in the sibling
 * `/[shortId]/+server.ts` files in TASK-169.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { canvases, canvasParams, renderedImages } from '$lib/server/db/schema';
import { eq, and, or, isNull, sql, desc } from 'drizzle-orm';
import { requireApiKey } from '$lib/server/api-key';
import { resolveForwardUrl } from '$lib/server/forward-url';
import { validateParams } from '$lib/server/canvas-params';
import {
	acquireRenderSlot,
	RenderBusyError,
	RENDER_THROTTLE_CONFIG
} from '$lib/server/render-throttle';
import { buildContentHashInputs, renderForUser, FORMAT_EXTENSIONS } from '$lib/server/baked-render';
import { generateShortId } from '$lib/server/short-id';
import { getLiveUserFontDescriptors } from '$lib/server/user-fonts';
import { collectAssetReferences, loadAssetFingerprint } from '$lib/server/asset-resolver';
import {
	assetSetVersionFromEntries,
	fontSetVersionFromDescriptors
} from '$lib/server/content-version';
import { getStorage } from '$lib/server/storage';
import { publicAppOrigin, shareUrlFor, imageUrlFor } from '$lib/server/render-permalink';
import { enforceApiKeyRateLimit } from '$lib/server/api-rate-limit';
import type { OutputFormat, FabricCanvasJson } from '$lib/engine';

/** Default user-scoped render quota — overridable by the operator at
 *  process start via the RENDER_QUOTA_PER_USER env var. 1000 rows is
 *  generous for v0.5 self-host scale; production deployments turning
 *  this up should also turn up Postgres's max connections and consider
 *  a backfill of `expires_at` for older rows. */
const DEFAULT_QUOTA = 1000;

const ALLOWED_FORMATS: ReadonlySet<OutputFormat> = new Set(['png', 'jpeg', 'webp', 'avif']);

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
	'canvas',
	'params',
	'format',
	'forwardUrl',
	'ogTitle',
	'ogDescription',
	'dpr'
]);

const MAX_OG_LENGTH = 300;
const MAX_PARAM_VALUE_LENGTH = 2_000;

/**
 * Throw a structured JSON 400 response. We throw a `Response` (not
 * SvelteKit's `error()`) so the body is rendered as the literal JSON
 * shape API integrators expect — `error()` always wraps in a
 * `{ message: string }` envelope, which the spec rules out.
 */
function badRequest(payload: Record<string, unknown>): never {
	throw new Response(JSON.stringify(payload), {
		status: 400,
		headers: { 'Content-Type': 'application/json' }
	});
}

function looksLikeUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function clampDpr(raw: unknown): number {
	if (raw === undefined || raw === null) return 1;
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n)) badRequest({ error: 'invalid_dpr', message: 'dpr must be 1, 2, or 3' });
	const v = Math.floor(n);
	if (v < 1 || v > 3) badRequest({ error: 'invalid_dpr', message: 'dpr must be 1, 2, or 3' });
	return v;
}

export const POST: RequestHandler = async ({ request, locals, url }) => {
	const apiKey = requireApiKey(locals, 'render:create');
	// Per-API-key rate gate. Throws a structured 429 with Retry-After +
	// X-RateLimit headers on exhaustion; returns a `decorate(response)`
	// closure for the success path that attaches the limit headers to
	// the eventual 2xx.
	const decorate = enforceApiKeyRateLimit(apiKey.id, 'write');

	// Body parse + shape check
	const body = await request.json().catch(() => null);
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		badRequest({ error: 'invalid_body', message: 'expected a JSON object' });
	}
	for (const key of Object.keys(body)) {
		if (!ALLOWED_KEYS.has(key)) {
			badRequest({ error: 'unknown_field', field: key });
		}
	}

	const rawCanvas = (body as Record<string, unknown>).canvas;
	if (typeof rawCanvas !== 'string' || rawCanvas.length === 0) {
		badRequest({ error: 'invalid_canvas', message: 'canvas (slug or uuid) is required' });
	}
	const rawParams = (body as Record<string, unknown>).params ?? {};
	if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
		badRequest({ error: 'invalid_params', message: 'params must be an object of string values' });
	}
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
		if (typeof value !== 'string') {
			badRequest({ error: 'invalid_params', field: key, message: 'must be a string' });
		}
		if (value.length > MAX_PARAM_VALUE_LENGTH) {
			badRequest({
				error: 'invalid_params',
				field: key,
				message: `value exceeds ${MAX_PARAM_VALUE_LENGTH} characters`
			});
		}
		params[key] = value;
	}

	const rawFormat = (body as Record<string, unknown>).format ?? 'png';
	if (typeof rawFormat !== 'string' || !ALLOWED_FORMATS.has(rawFormat as OutputFormat)) {
		badRequest({
			error: 'invalid_format',
			message: 'format must be one of png, jpeg, webp, avif'
		});
	}
	const format = rawFormat as OutputFormat;

	const rawForwardUrl = (body as Record<string, unknown>).forwardUrl;
	if (rawForwardUrl !== undefined && rawForwardUrl !== null && typeof rawForwardUrl !== 'string') {
		badRequest({ error: 'invalid_forward_url', message: 'must be a string or null' });
	}

	const rawOgTitle = (body as Record<string, unknown>).ogTitle;
	if (rawOgTitle !== undefined && rawOgTitle !== null && typeof rawOgTitle !== 'string') {
		badRequest({ error: 'invalid_og_title', message: 'must be a string or null' });
	}
	if (typeof rawOgTitle === 'string' && rawOgTitle.length > MAX_OG_LENGTH) {
		badRequest({ error: 'invalid_og_title', message: `exceeds ${MAX_OG_LENGTH} characters` });
	}

	const rawOgDescription = (body as Record<string, unknown>).ogDescription;
	if (
		rawOgDescription !== undefined &&
		rawOgDescription !== null &&
		typeof rawOgDescription !== 'string'
	) {
		badRequest({ error: 'invalid_og_description', message: 'must be a string or null' });
	}
	if (typeof rawOgDescription === 'string' && rawOgDescription.length > MAX_OG_LENGTH) {
		badRequest({
			error: 'invalid_og_description',
			message: `exceeds ${MAX_OG_LENGTH} characters`
		});
	}

	const dpr = clampDpr((body as Record<string, unknown>).dpr);

	// Resolve canvas. We accept slug OR uuid — the latter is convenient
	// for integrators that already store internal IDs. Both are scoped
	// to the API-key's owning user; cross-user references collapse to
	// the same 404 to avoid leaking existence.
	const conditions = looksLikeUuid(rawCanvas)
		? or(eq(canvases.id, rawCanvas), eq(canvases.slug, rawCanvas))
		: eq(canvases.slug, rawCanvas);
	const [canvas] = await db
		.select()
		.from(canvases)
		.where(and(conditions, eq(canvases.userId, apiKey.userId)))
		.limit(1);
	if (!canvas) {
		throw new Response(JSON.stringify({ error: 'canvas_not_found' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Strict validation — API integrators want to know when they
	// misconfigure a binding. Lenient mode is intentionally for the
	// public crawler-friendly path.
	const paramDefs = await db
		.select()
		.from(canvasParams)
		.where(eq(canvasParams.canvasId, canvas.id));
	const validation = validateParams(params, paramDefs, { lenient: false });
	if (!validation.ok) {
		badRequest({ error: 'invalid_param', field: validation.field, message: validation.reason });
	}
	const resolvedParams = validation.resolved;

	// Resolve forwardUrl through the shared helper from TASK-165. The
	// http(s) allowlist + warning logs are identical to the /c/{slug}
	// security boundary, so the interstitial at /i/{shortId} can render
	// the CTA verbatim from this stored value.
	let bakedForwardUrl: string | null = null;
	if (typeof rawForwardUrl === 'string' && rawForwardUrl.length > 0) {
		const fwd = resolveForwardUrl(rawForwardUrl, resolvedParams);
		if (!fwd) {
			bakedForwardUrl = null;
		} else if (fwd.ok) {
			bakedForwardUrl = fwd.url;
		} else if (fwd.reason === 'invalid-scheme') {
			badRequest({
				error: 'invalid_forward_url',
				message: 'forwardUrl must resolve to http or https'
			});
		} else {
			badRequest({
				error: 'invalid_forward_url',
				message: 'forwardUrl could not be parsed after substitution'
			});
		}
	}

	const ogTitle = typeof rawOgTitle === 'string' ? rawOgTitle : null;
	const ogDescription = typeof rawOgDescription === 'string' ? rawOgDescription : null;

	// Font + asset fingerprints follow the live render route's
	// cache-invalidation model. Without these the dedup path returns the
	// pre-edit baked bytes when a referenced font is uploaded/deleted
	// (GlobalFonts has no unregister) or a referenced `asset://` is
	// replaced/deleted between two identical POSTs (Codex TASK-168 round 2).
	const liveFontDescriptors = await getLiveUserFontDescriptors(apiKey.userId);
	const fontSetVersion = fontSetVersionFromDescriptors(liveFontDescriptors);
	const referencedAssetIds = collectAssetReferences(
		canvas.templateJson as unknown as FabricCanvasJson | null
	);
	const assetEntries =
		referencedAssetIds.length > 0
			? await loadAssetFingerprint(referencedAssetIds, apiKey.userId)
			: [];
	const assetSetVersion = assetSetVersionFromEntries(assetEntries);

	const contentHashInput = buildContentHashInputs({
		userId: apiKey.userId,
		canvasId: canvas.id,
		// Folding canvas.updatedAt in here means a canvas edit between two
		// identical-body POSTs produces a new shortId rather than returning
		// the stale baked bytes (Codex TASK-168 round 1 P1). Matches the live
		// render route's cache-busting model.
		canvasVersion: canvas.updatedAt.toISOString(),
		fontSetVersion,
		assetSetVersion,
		params: resolvedParams,
		format,
		dpr,
		forwardUrl: bakedForwardUrl,
		ogTitle,
		ogDescription
	});
	const contentHash = createHash('sha256').update(contentHashInput).digest('hex');

	const appUrl = publicAppOrigin(url.origin);

	// Dedup lookup. `(user_id, content_hash)` is indexed; the partial-
	// index on `expires_at` doesn't help us here so the index covers
	// every row including soft-deleted ones — we filter in app code.
	const [existing] = await db
		.select()
		.from(renderedImages)
		.where(
			and(
				eq(renderedImages.userId, apiKey.userId),
				eq(renderedImages.contentHash, contentHash),
				isNull(renderedImages.deletedAt)
			)
		)
		.limit(1);
	if (existing) {
		// Bump lastAccessedAt async so the dedup hit reflects continued
		// usage without blocking the response.
		const existingId = existing.id;
		setImmediate(() => {
			db.update(renderedImages)
				.set({ lastAccessedAt: new Date() })
				.where(eq(renderedImages.id, existingId))
				.catch((err) => {
					console.warn(`[renders] lastAccessedAt bump failed id=${existingId}`, err);
				});
		});
		const ext = FORMAT_EXTENSIONS[existing.format as OutputFormat]?.ext ?? 'png';
		return decorate(
			json(
				{
					id: existing.shortId,
					url: `${appUrl}/i/${existing.shortId}`,
					imageUrl: `${appUrl}/i/${existing.shortId}/image.${ext}`,
					forwardUrl: existing.forwardUrl,
					deduplicated: true,
					createdAt: existing.createdAt.toISOString()
				},
				{ status: 200 }
			)
		);
	}

	// Quota gate. Counts live (non-deleted) rows; revoked API keys still
	// see their renders count against the user's pool.
	const quotaLimit = Number(
		(env as Record<string, string | undefined>).RENDER_QUOTA_PER_USER ?? DEFAULT_QUOTA
	);
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(renderedImages)
		.where(and(eq(renderedImages.userId, apiKey.userId), isNull(renderedImages.deletedAt)));
	if (count >= quotaLimit) {
		return new Response(
			JSON.stringify({ error: 'quota_exceeded', limit: quotaLimit, current: count }),
			{ status: 429, headers: { 'Content-Type': 'application/json' } }
		);
	}

	// Acquire a render slot. The throttle module is process-wide, so
	// public renders + baked-render POSTs share the same semaphore on
	// purpose — they're both CPU-bound on the same renderer.
	let releaseSlot: () => void;
	try {
		releaseSlot = await acquireRenderSlot();
	} catch (err) {
		if (err instanceof RenderBusyError) {
			return new Response(
				JSON.stringify({ error: 'render_busy', retryAfterSeconds: err.retryAfterSeconds }),
				{
					status: 503,
					headers: {
						'Content-Type': 'application/json',
						'Retry-After': String(err.retryAfterSeconds),
						'X-Render-Concurrency': String(RENDER_THROTTLE_CONFIG.concurrency)
					}
				}
			);
		}
		throw err;
	}

	let storageKey: string | null = null;
	try {
		const rendered = await renderForUser(canvas, resolvedParams, { format, dpr });

		// Storage key uses a fresh random UUID, NOT the shortId. Decoupling
		// them means a (vanishingly unlikely) shortId collision in the retry
		// loop can't accidentally overwrite another row's existing blob path
		// (Codex TASK-168 round 2). The shortId is the public-facing
		// identifier; the storage key only needs to be unique within the
		// user's namespace.
		const blobKey = `renders/${apiKey.userId}/${randomUUID()}.${FORMAT_EXTENSIONS[format].ext}`;
		await getStorage().upload(blobKey, rendered.buffer, FORMAT_EXTENSIONS[format].contentType);
		storageKey = blobKey;

		// Insert loop: a single render's bytes are uploaded once and tried
		// against a fresh short id up to MAX_SHORT_ID_ATTEMPTS times in case
		// of a nanoid collision (vanishingly unlikely at this scale, but the
		// DB column is UNIQUE so we have to handle it). If the
		// `(user_id, content_hash)` UNIQUE index trips, a concurrent POST
		// won the dedup race — the just-uploaded bytes are best-effort
		// deleted and the winning row is returned with `deduplicated: true`
		// (Codex TASK-168 round 1 P2).
		const MAX_SHORT_ID_ATTEMPTS = 5;
		let inserted: typeof renderedImages.$inferSelect | null = null;
		let lastErr: unknown;
		for (let attempt = 0; attempt < MAX_SHORT_ID_ATTEMPTS; attempt++) {
			const shortId = generateShortId();
			try {
				const [row] = await db
					.insert(renderedImages)
					.values({
						shortId,
						userId: apiKey.userId,
						apiKeyId: apiKey.id,
						canvasId: canvas.id,
						params: resolvedParams,
						format,
						storageKey: blobKey,
						sizeBytes: rendered.sizeBytes,
						width: rendered.width,
						height: rendered.height,
						forwardUrl: bakedForwardUrl,
						ogTitle,
						ogDescription,
						contentHash
					})
					.returning();
				inserted = row;
				// Mark the blob as committed — the outer cleanup must NOT
				// touch it on success.
				storageKey = null;
				break;
			} catch (err) {
				lastErr = err;
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('rendered_images_user_content_hash_live_uidx')) {
					// Content-hash race lost. Drop the orphan blob and return
					// the winner as a dedup hit.
					await getStorage()
						.delete(blobKey)
						.catch(() => {
							/* best-effort */
						});
					storageKey = null;
					// Dedup race lost. Look up the winning row and return it
					// as a dedup hit. If for some reason the winning row
					// can't be located (constraint without a row is
					// vanishingly unlikely but possible during a brief
					// window), fall through to the error path.
					const [winner] = await db
						.select()
						.from(renderedImages)
						.where(
							and(
								eq(renderedImages.userId, apiKey.userId),
								eq(renderedImages.contentHash, contentHash),
								isNull(renderedImages.deletedAt)
							)
						)
						.limit(1);
					if (winner) {
						const winnerExt = FORMAT_EXTENSIONS[winner.format as OutputFormat]?.ext ?? 'png';
						return decorate(
							json(
								{
									id: winner.shortId,
									url: `${appUrl}/i/${winner.shortId}`,
									imageUrl: `${appUrl}/i/${winner.shortId}/image.${winnerExt}`,
									forwardUrl: winner.forwardUrl,
									deduplicated: true,
									createdAt: winner.createdAt.toISOString()
								},
								{ status: 200 }
							)
						);
					}
					throw err;
				}
				if (msg.includes('rendered_images_short_id_unique')) {
					// Re-roll the shortId. The uploaded blob is keyed by a
					// random UUID independent of the shortId (see above), so
					// it stays valid for the next insert attempt — no upload
					// or cleanup needed in this branch.
					continue;
				}
				// Any other insert failure — bubble up to the outer catch.
				throw err;
			}
		}
		if (!inserted) {
			// Exhausted shortId attempts — should never happen at this scale.
			throw lastErr ?? new Error('Could not allocate a unique shortId');
		}

		const ext = FORMAT_EXTENSIONS[inserted.format as OutputFormat]?.ext ?? 'png';
		return decorate(
			json(
				{
					id: inserted.shortId,
					url: `${appUrl}/i/${inserted.shortId}`,
					imageUrl: `${appUrl}/i/${inserted.shortId}/image.${ext}`,
					forwardUrl: inserted.forwardUrl,
					deduplicated: false,
					createdAt: inserted.createdAt.toISOString()
				},
				{ status: 201 }
			)
		);
	} catch (err) {
		// Anything that escapes the inner retry: a propagated insert
		// failure that already cleaned up bytes, OR an unexpected throw
		// from the render pipeline before we uploaded. Either way, leave
		// nothing behind.
		if (storageKey) {
			await getStorage()
				.delete(storageKey)
				.catch(() => {
					/* best-effort */
				});
		}
		console.error('[renders] POST failed', err);
		throw err;
	} finally {
		releaseSlot();
	}
};

// ─── GET /api/v1/renders (list) ──────────────────────────────────────────
//
// Paginated by an opaque (createdAt, id) cursor so two rows created in
// the same millisecond can't both be on the page boundary. The cursor
// is base64-encoded JSON — clients must NOT parse it; the encoding may
// change without notice.

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface Cursor {
	/** Raw Postgres timestamptz text (full precision, including microseconds
	 *  if present). Carried as text — never round-tripped through a JS
	 *  Date — so the next page's tuple comparison against the row's full-
	 *  precision createdAt can't skip rows that share a millisecond
	 *  with the cursor row but differ in microseconds (Codex round 1 P1). */
	createdAt: string;
	id: string;
}

const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres timestamptz `::text` output shape, plus the ISO-with-`T` shape
 *  in case a cursor lands here from elsewhere. The leading 4-digit year
 *  is intentional — JS `Date` accepts huge extended-year strings like
 *  `"-100000-01-01T00:00:00Z"` that Postgres rejects outside its
 *  timestamptz range, surfacing as a 500 instead of `invalid_cursor`
 *  400 (Codex round 2). The regex also rejects junk that looks like a
 *  timestamp but Postgres can't parse. Offset components are captured
 *  separately so we can bound them (Codex round 4). */
const CURSOR_TIMESTAMP_RE =
	/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::(\d{2}))?)?$/;

/** True iff `value` is a syntactically-valid AND calendar-valid Postgres
 *  timestamptz text with a bounded timezone offset.
 *
 *  - Regex handles the syntactic shape (Codex round 2 — extended-year).
 *  - `Date.UTC` round-trip catches calendar-invalid dates like
 *    `2024-02-31` that JS would normalize and silently pass through to
 *    Postgres, which rejects them as 22008 (Codex round 3).
 *  - Offset hours and minutes are explicitly bounded so junk like
 *    `+99:99` is rejected at decode rather than tripping Postgres's
 *    datetime-overflow error and surfacing as a 500 (Codex round 4).
 */
function isValidCursorTimestamp(value: string): boolean {
	const m = CURSOR_TIMESTAMP_RE.exec(value);
	if (!m) return false;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = Number(m[6]);
	// Cheap bounds first.
	if (year < 1900 || year > 9999) return false;
	if (month < 1 || month > 12) return false;
	if (day < 1 || day > 31) return false;
	if (hour > 23 || minute > 59 || second > 60) return false;
	// Offset bounds. Postgres caps timezone offset at ±15:59:59 (per
	// the time-zone abbreviation table); ISO 8601 caps at ±14:00.
	// Reject anything wider so a craft cursor can't trip 22008.
	if (m[7] !== undefined) {
		const offsetHour = Number(m[7]);
		if (offsetHour > 15) return false;
	}
	if (m[8] !== undefined) {
		const offsetMinute = Number(m[8]);
		if (offsetMinute > 59) return false;
	}
	// Round-trip: JS normalizes Feb-31 etc. to a different calendar day;
	// if the round-trip changed any component, the input wasn't a real
	// date.
	const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	return (
		d.getUTCFullYear() === year &&
		d.getUTCMonth() === month - 1 &&
		d.getUTCDate() === day &&
		d.getUTCHours() === hour &&
		d.getUTCMinutes() === minute &&
		d.getUTCSeconds() === second
	);
}

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
	try {
		const json = Buffer.from(raw, 'base64url').toString('utf8');
		const parsed = JSON.parse(json) as Partial<Cursor>;
		if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
		// Validate the id looks like a uuid — otherwise the `::uuid` cast in
		// the tuple comparison below trips a Postgres parse error that
		// surfaces as 500 instead of the intended structured 400
		// (Codex round 1 P2).
		if (!CURSOR_UUID_RE.test(parsed.id)) return null;
		// Shape + calendar validation. The strict check rejects strings JS
		// would happily parse but Postgres rejects (extended years, Feb 31
		// etc. — Codex rounds 2 + 3). Without this the `::timestamptz`
		// cast surfaces as a 500 instead of the intended `invalid_cursor`
		// 400.
		if (!isValidCursorTimestamp(parsed.createdAt)) return null;
		return { createdAt: parsed.createdAt, id: parsed.id };
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async ({ locals, url }) => {
	requireApiKey(locals, 'render:read');
	const apiKey = locals.apiKey!;
	const decorate = enforceApiKeyRateLimit(apiKey.id, 'read');

	const rawLimit = url.searchParams.get('limit');
	let limit = DEFAULT_LIMIT;
	if (rawLimit !== null) {
		const n = Number(rawLimit);
		if (!Number.isInteger(n) || n < 1) {
			badRequest({ error: 'invalid_limit', message: 'limit must be a positive integer' });
		}
		if (n > MAX_LIMIT) {
			badRequest({ error: 'invalid_limit', message: `limit must be ${MAX_LIMIT} or fewer` });
		}
		limit = n;
	}

	const rawCursor = url.searchParams.get('cursor');
	let cursor: Cursor | null = null;
	if (rawCursor !== null) {
		cursor = decodeCursor(rawCursor);
		if (cursor === null) {
			badRequest({ error: 'invalid_cursor', message: 'cursor could not be decoded' });
		}
	}

	const canvasRef = url.searchParams.get('canvas');
	let canvasFilter: string | null = null; // canvas UUID, post-resolution
	if (canvasRef !== null && canvasRef.length > 0) {
		// Owner-scoped — a cross-user canvas reference filters to no rows
		// (rather than 404'ing) because the list semantics are "the
		// renders YOU made"; an empty page for an unknown filter value is
		// the right answer.
		const conditions = looksLikeUuid(canvasRef)
			? or(eq(canvases.id, canvasRef), eq(canvases.slug, canvasRef))
			: eq(canvases.slug, canvasRef);
		const [canvasRow] = await db
			.select({ id: canvases.id })
			.from(canvases)
			.where(and(conditions, eq(canvases.userId, apiKey.userId)))
			.limit(1);
		if (!canvasRow) {
			return decorate(json({ items: [], nextCursor: null }));
		}
		canvasFilter = canvasRow.id;
	}

	// LEFT JOIN to canvases for the convenience-fields (canvasSlug, name).
	// Pull `limit + 1` rows so we can detect a next page without an
	// extra COUNT(*). The extra row is dropped from the response.
	const conditions = [eq(renderedImages.userId, apiKey.userId), isNull(renderedImages.deletedAt)];
	if (canvasFilter !== null) {
		conditions.push(eq(renderedImages.canvasId, canvasFilter));
	}
	if (cursor) {
		// Tuple comparison (createdAt, id) < (cursorTs, cursorId) — Drizzle
		// doesn't have a tuple comparator built-in, so reach into `sql` for
		// the row-value clause. Postgres tuple < is lexicographic, exactly
		// what we want for a stable DESC sort.
		conditions.push(
			sql`(${renderedImages.createdAt}, ${renderedImages.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
		);
	}

	const rows = await db
		.select({
			id: renderedImages.id,
			shortId: renderedImages.shortId,
			canvasId: renderedImages.canvasId,
			canvasSlug: canvases.slug,
			canvasName: canvases.name,
			format: renderedImages.format,
			sizeBytes: renderedImages.sizeBytes,
			width: renderedImages.width,
			height: renderedImages.height,
			forwardUrl: renderedImages.forwardUrl,
			ogTitle: renderedImages.ogTitle,
			ogDescription: renderedImages.ogDescription,
			createdAt: renderedImages.createdAt,
			// Pull the raw Postgres text representation alongside the parsed
			// Date. JS truncates timestamptz to milliseconds at parse time,
			// so encoding `createdAt.toISOString()` into the cursor would
			// skip microsecond-disambiguated rows on the next page
			// (Codex round 1 P1). The text preserves Postgres's full
			// precision and is round-tripped verbatim via `::timestamptz`
			// in the tuple comparison.
			createdAtText: sql<string>`${renderedImages.createdAt}::text`,
			lastAccessedAt: renderedImages.lastAccessedAt,
			expiresAt: renderedImages.expiresAt
		})
		.from(renderedImages)
		.leftJoin(canvases, eq(canvases.id, renderedImages.canvasId))
		.where(and(...conditions))
		.orderBy(desc(renderedImages.createdAt), desc(renderedImages.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page[page.length - 1];
	const nextCursor =
		hasMore && last ? encodeCursor({ createdAt: last.createdAtText, id: last.id }) : null;

	const appUrl = publicAppOrigin(url.origin);
	const items = page.map((row) => ({
		id: row.shortId,
		url: shareUrlFor(appUrl, row.shortId),
		imageUrl: imageUrlFor(appUrl, row.shortId, row.format),
		canvasId: row.canvasId,
		canvasSlug: row.canvasSlug,
		canvasName: row.canvasName,
		format: row.format,
		sizeBytes: row.sizeBytes,
		width: row.width,
		height: row.height,
		forwardUrl: row.forwardUrl,
		ogTitle: row.ogTitle,
		ogDescription: row.ogDescription,
		createdAt: row.createdAt.toISOString(),
		lastAccessedAt: row.lastAccessedAt.toISOString(),
		expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null
	}));

	return decorate(json({ items, nextCursor }));
};
