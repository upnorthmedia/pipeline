ALTER TABLE "posts" ALTER COLUMN "output_format" SET DEFAULT 'markdown';--> statement-breakpoint
ALTER TABLE "website_profiles" ALTER COLUMN "output_format" SET DEFAULT 'markdown';--> statement-breakpoint
-- Rows that took the old column default. `both` names no destination any
-- publish step handles: `POST /api/posts/{id}/publish` answers it with
-- `Publishing not supported for output_format 'both'` and the auto-publish
-- hook skips it, so these rows publish nowhere today and publish nowhere
-- after this. What changes is that the picker can render them.
UPDATE "posts" SET "output_format" = 'markdown' WHERE "output_format" = 'both';--> statement-breakpoint
UPDATE "website_profiles" SET "output_format" = 'markdown' WHERE "output_format" = 'both';
