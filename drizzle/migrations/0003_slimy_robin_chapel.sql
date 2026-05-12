CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hashed_secret" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "rendered_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text NOT NULL,
	"user_id" text NOT NULL,
	"api_key_id" uuid,
	"canvas_id" uuid NOT NULL,
	"params" jsonb NOT NULL,
	"format" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"forward_url" text,
	"og_title" text,
	"og_description" text,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "rendered_images_short_id_unique" UNIQUE("short_id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendered_images" ADD CONSTRAINT "rendered_images_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendered_images" ADD CONSTRAINT "rendered_images_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendered_images" ADD CONSTRAINT "rendered_images_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rendered_images_user_id_idx" ON "rendered_images" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rendered_images_user_content_hash_idx" ON "rendered_images" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "rendered_images_expires_at_live_idx" ON "rendered_images" USING btree ("expires_at") WHERE "rendered_images"."deleted_at" IS NULL AND "rendered_images"."expires_at" IS NOT NULL;