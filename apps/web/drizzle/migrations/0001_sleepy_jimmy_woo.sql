ALTER TABLE "canvases" ADD COLUMN "folder" text;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;