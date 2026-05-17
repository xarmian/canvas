import { sql, desc } from 'drizzle-orm';
import {
	pgTable,
	text,
	timestamp,
	uuid,
	integer,
	boolean,
	jsonb,
	index,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

// Re-export auth schema so everything is accessible from one place
export * from './auth-schema.js';

// ─── Canvases ────────────────────────────────────────────────────────────────
// A template design owned by a user.

export const canvases = pgTable(
	'canvases',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		slug: text('slug').notNull().unique(),
		width: integer('width').notNull().default(1200),
		height: integer('height').notNull().default(630),
		backgroundType: text('background_type').notNull().default('color'), // 'color' | 'image'
		backgroundValue: text('background_value').notNull().default('#ffffff'),
		templateJson: jsonb('template_json').$type<Record<string, unknown>>(),
		published: boolean('published').notNull().default(false),
		redirectUrl: text('redirect_url'),
		ogTitle: text('og_title'),
		ogDescription: text('og_description'),
		// Single-string folder for dashboard grouping. NULL = "uncategorized".
		// Kept as a free-form string (not a separate table) because v0.4
		// users have small libraries, no nesting, and no per-folder
		// permissions; any of those needs would mean restructuring anyway.
		folder: text('folder'),
		// Free-form tag list. Stored as a Postgres text[] (not jsonb) so we
		// can index with GIN and use `?| array[...]` operators later.
		// Empty array (not null) is the default — keeps the dashboard's
		// `canvas.tags.includes(...)` checks branchless.
		tags: text('tags').array().notNull().default([]),
		// Monotonic optimistic-concurrency token (TASK-98 round 14).
		// `updatedAt` alone is not safe — millisecond precision means
		// two writes in the same ms collide on the same version. The
		// PATCH endpoint includes a `lock_version = expected` predicate
		// in the UPDATE's WHERE clause and increments the column in the
		// SET clause, so a stale `If-Match` request fails atomically
		// even on sub-ms races. Starts at 0; clients use the value
		// returned by GET as the `If-Match` token.
		lockVersion: integer('lock_version').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [index('canvases_user_id_idx').on(table.userId)]
);

// ─── Canvas Parameters ───────────────────────────────────────────────────────
// Defines the URL parameters a canvas accepts.

export const canvasParams = pgTable(
	'canvas_params',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		canvasId: uuid('canvas_id')
			.notNull()
			.references(() => canvases.id, { onDelete: 'cascade' }),
		name: text('name').notNull(), // e.g. "title", "avatar_url"
		type: text('type').notNull().default('text'), // 'text' | 'image' | 'color' | 'number'
		defaultValue: text('default_value'),
		required: boolean('required').notNull().default(false),
		description: text('description'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('canvas_params_canvas_id_idx').on(table.canvasId)]
);

// ─── Assets ──────────────────────────────────────────────────────────────────
// Uploaded images and fonts stored in S3-compatible storage.

export const assets = pgTable(
	'assets',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		filename: text('filename').notNull(),
		storageKey: text('storage_key').notNull().unique(),
		contentType: text('content_type').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('assets_user_id_idx').on(table.userId)]
);

// ─── API Keys ────────────────────────────────────────────────────────────────
// Bearer tokens that let an external system drive the Programmatic Render API
// (POST /api/v1/renders, etc). One row per key. The secret is never stored;
// only its argon2id hash. `prefix` is the non-secret first 12 chars
// (`ck_live_xxxx`) — auth narrows by prefix before verifying the argon2
// hash, and the UI uses it to disambiguate keys for the user.

export const apiKeys = pgTable(
	'api_keys',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Cascade matches the auth-table pattern: revoking a user drops their keys.
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		// User-facing label, e.g. "Production server".
		name: text('name').notNull(),
		// Non-secret prefix used for narrow lookup before argon2 verify; the full
		// secret is never persisted. Collisions on insert re-roll the secret.
		prefix: text('prefix').notNull().unique(),
		// argon2id hash of the full bearer token.
		hashedSecret: text('hashed_secret').notNull(),
		// Scope tokens (e.g. 'render:create'). Stored as text[] (not an enum) so
		// future scopes are additive without a migration; validation lives in
		// app code.
		scopes: text('scopes').array().notNull().default([]),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
		// Soft-revoke: auth queries filter `revoked_at IS NULL` so revoked keys
		// can still be displayed in the UI's history without re-authenticating.
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('api_keys_user_id_idx').on(table.userId)]
);

// ─── Rendered Images ─────────────────────────────────────────────────────────
// Baked render rows: each row points at the bytes in object storage for a
// single POST /api/v1/renders result. Addressed publicly by `shortId`
// (nanoid(10)) at `/i/{shortId}`.

export const renderedImages = pgTable(
	'rendered_images',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Public, URL-safe identifier (nanoid(10)). Unique across the table.
		shortId: text('short_id').notNull().unique(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		// Nullable to forward-compat session-cookie POSTs that may not have a
		// key attached. Set null on delete so revoking a key doesn't take down
		// the renders it produced.
		apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
		// Cascade delete for v1 — mirrors how `canvas_params` cascade with their
		// canvas. When IDEA-59 (soft-delete + published snapshots) lands this
		// becomes set-null with snapshot survival.
		canvasId: uuid('canvas_id')
			.notNull()
			.references(() => canvases.id, { onDelete: 'cascade' }),
		// Resolved + validated param snapshot at create time.
		params: jsonb('params').$type<Record<string, unknown>>().notNull(),
		// 'png' | 'jpeg' | 'webp' | 'avif'
		format: text('format').notNull(),
		storageKey: text('storage_key').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		// Resolved + http(s)-validated at create time. Click-through target for
		// the /i/{shortId} interstitial.
		forwardUrl: text('forward_url'),
		ogTitle: text('og_title'),
		ogDescription: text('og_description'),
		// sha256 hex (64 chars) of the canonicalized inputs — used together with
		// userId to dedup re-POSTs.
		contentHash: text('content_hash').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }),
		// Soft-delete marker; the sweep CLI hard-deletes rows past their grace
		// window.
		deletedAt: timestamp('deleted_at', { withTimezone: true })
	},
	(table) => [
		index('rendered_images_user_id_idx').on(table.userId),
		// Dedup constraint: (userId, contentHash) is unique among live rows.
		// The POST endpoint does a select-then-insert to detect dedup; without
		// this constraint two concurrent identical POSTs can both miss the
		// select and create twin rows + twin blobs (Codex TASK-168 round 1
		// P2). The partial WHERE means a soft-deleted row no longer blocks
		// re-creation of the same render — the user genuinely wants a fresh
		// shortId in that case.
		uniqueIndex('rendered_images_user_content_hash_live_uidx')
			.on(table.userId, table.contentHash)
			.where(sql`${table.deletedAt} IS NULL`),
		// Partial index for the expiresAt sweep — narrow to live rows so the
		// sweeper's range scan ignores already-soft-deleted rows.
		index('rendered_images_expires_at_live_idx')
			.on(table.expiresAt)
			.where(sql`${table.deletedAt} IS NULL AND ${table.expiresAt} IS NOT NULL`)
	]
);

// ─── Render Events ───────────────────────────────────────────────────────────
// Append-only observation log for every render path (on-the-fly, baked,
// preview). Powers per-canvas / per-key / per-account usage counters and
// the instance-wide admin dashboard. Rows are immutable — there is no
// `deletedAt` column, and retention is enforced by a scheduled sweep on
// `created_at`. FKs are `set null` so revoking a key or deleting a canvas
// leaves the historical events readable for aggregate reporting.
//
// `ownerUserId` / `requesterUserId` are `text` (not `uuid`) to match the
// better-auth `user.id` column type — every other table in this schema
// references users that way.
//
// Indexes are tailored to the read patterns we have today:
//   • (canvas_id, created_at DESC)     — per-canvas usage card / chart
//   • (owner_user_id, created_at DESC) — /account/usage queries
//   • (api_key_id, created_at DESC)    — per-key counters (partial: skips
//                                        events without a key so the
//                                        session-cookie traffic doesn't
//                                        bloat the index)
//   • (created_at)                     — daily retention sweep range scan

export const renderEvents = pgTable(
	'render_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Which render path emitted this event. Free-form text instead of an
		// enum so new sources (e.g. 'baked-app-revalidate') don't need a
		// migration; valid values today are
		// 'on-the-fly' | 'baked-api' | 'baked-app' | 'preview'.
		source: text('source').notNull(),
		canvasId: uuid('canvas_id').references(() => canvases.id, { onDelete: 'set null' }),
		// `text` to match `user.id` from auth-schema. Owner is the canvas owner
		// at render-time; requester is whoever invoked the render (may differ
		// for baked/api paths where the requester is the API consumer).
		ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
		requesterUserId: text('requester_user_id').references(() => user.id, { onDelete: 'set null' }),
		apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
		// 'png' | 'jpg' | 'webp' | 'avif'. Open text so renderer-side format
		// additions don't need a schema change.
		format: text('format').notNull(),
		// sha256 hex of the canonicalized resolved params. Used to compute
		// cache-hit rates without storing the params themselves.
		paramsHash: text('params_hash').notNull(),
		cacheHit: boolean('cache_hit').notNull(),
		durationMs: integer('duration_ms').notNull(),
		statusCode: integer('status_code').notNull(),
		// sha256(salt + ':' + yyyy-mm-dd + ':' + ip). Null when no salt is
		// configured so we never store an identifiable IP fingerprint by
		// accident.
		ipHash: text('ip_hash'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('render_events_canvas_id_created_at_idx').on(table.canvasId, desc(table.createdAt)),
		index('render_events_owner_user_id_created_at_idx').on(
			table.ownerUserId,
			desc(table.createdAt)
		),
		index('render_events_api_key_id_created_at_idx')
			.on(table.apiKeyId, desc(table.createdAt))
			.where(sql`${table.apiKeyId} IS NOT NULL`),
		index('render_events_created_at_idx').on(table.createdAt)
	]
);

// ─── Admin Audit Log ─────────────────────────────────────────────────────────
// Append-only record of destructive admin actions. Written from
// `$lib/server/admin-audit.ts`. Deliberately no FK constraints on
// `actor_id` / `target_user_id`: an audit log must remember who-did-what
// even when the user rows are later removed. Storing the ids as text +
// a snapshot of the actor's email at-the-time keeps the log
// human-readable post-hoc without needing the user row to still exist.

export const adminAuditLog = pgTable(
	'admin_audit_log',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		actorId: text('actor_id').notNull(),
		actorEmail: text('actor_email').notNull(),
		// Stable action name, e.g. 'force_delete_user_renders'. Validation
		// lives in the writer — the schema is intentionally open so new
		// admin actions don't require a migration each time.
		action: text('action').notNull(),
		targetUserId: text('target_user_id'),
		// Action-specific structured payload, e.g. { deletedRenderCount: 42 }.
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('admin_audit_log_actor_idx').on(table.actorId),
		index('admin_audit_log_target_idx').on(table.targetUserId),
		index('admin_audit_log_created_idx').on(table.createdAt)
	]
);
