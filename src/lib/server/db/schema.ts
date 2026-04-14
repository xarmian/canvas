import {
	pgTable,
	text,
	timestamp,
	uuid,
	integer,
	boolean,
	jsonb,
	index
} from 'drizzle-orm/pg-core';

// ─── Users ───────────────────────────────────────────────────────────────────
// Core user table. Better Auth will add its own tables alongside this.

export const users = pgTable('users', {
	id: uuid('id').primaryKey().defaultRandom(),
	email: text('email').notNull().unique(),
	name: text('name').notNull(),
	avatarUrl: text('avatar_url'),
	emailVerified: boolean('email_verified').notNull().default(false),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date())
});

// ─── Canvases ────────────────────────────────────────────────────────────────
// A template design owned by a user.

export const canvases = pgTable(
	'canvases',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
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
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		index('canvases_user_id_idx').on(table.userId),
		index('canvases_slug_idx').on(table.slug)
	]
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
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		filename: text('filename').notNull(),
		storageKey: text('storage_key').notNull().unique(),
		contentType: text('content_type').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('assets_user_id_idx').on(table.userId)]
);
