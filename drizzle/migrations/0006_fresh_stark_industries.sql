CREATE TABLE "render_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"canvas_id" uuid,
	"owner_user_id" text,
	"requester_user_id" text,
	"api_key_id" uuid,
	"format" text NOT NULL,
	"params_hash" text NOT NULL,
	"cache_hit" boolean NOT NULL,
	"duration_ms" integer NOT NULL,
	"status_code" integer NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "render_events" ADD CONSTRAINT "render_events_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_events" ADD CONSTRAINT "render_events_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_events" ADD CONSTRAINT "render_events_requester_user_id_user_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_events" ADD CONSTRAINT "render_events_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "render_events_canvas_id_created_at_idx" ON "render_events" USING btree ("canvas_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "render_events_owner_user_id_created_at_idx" ON "render_events" USING btree ("owner_user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "render_events_api_key_id_created_at_idx" ON "render_events" USING btree ("api_key_id","created_at" desc) WHERE "render_events"."api_key_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "render_events_created_at_idx" ON "render_events" USING btree ("created_at");