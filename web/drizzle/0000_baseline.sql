CREATE TABLE "alembic_version" (
	"version_num" varchar(32) NOT NULL,
	CONSTRAINT "alembic_version_pkc" PRIMARY KEY("version_num")
);
--> statement-breakpoint
CREATE TABLE "internal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"slug" varchar(255),
	"source" varchar(20) DEFAULT 'sitemap',
	"post_id" uuid,
	"keywords" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_internal_links_profile_url" UNIQUE("profile_id","url")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"slug" varchar(255) NOT NULL,
	"topic" text NOT NULL,
	"target_audience" text,
	"niche" text,
	"intent" text,
	"word_count" integer DEFAULT 2000,
	"tone" text DEFAULT 'Conversational and friendly',
	"output_format" varchar(20) DEFAULT 'both',
	"website_url" text,
	"related_keywords" jsonb DEFAULT '[]'::jsonb,
	"competitor_urls" jsonb DEFAULT '[]'::jsonb,
	"image_style" text,
	"image_brand_colors" jsonb DEFAULT '[]'::jsonb,
	"image_exclude" jsonb DEFAULT '[]'::jsonb,
	"brand_voice" text,
	"avoid" text,
	"required_mentions" text,
	"research_content" text,
	"outline_content" text,
	"draft_content" text,
	"final_md_content" text,
	"final_html_content" text,
	"image_manifest" jsonb,
	"stage_logs" jsonb DEFAULT '{}'::jsonb,
	"current_stage" varchar(20) DEFAULT 'pending',
	"stage_settings" jsonb DEFAULT '{"edit":"review","write":"review","images":"review","outline":"review","research":"review"}'::jsonb,
	"stage_status" jsonb DEFAULT '{}'::jsonb,
	"priority" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone,
	"ready_content" text,
	"execution_logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wp_category_id" integer,
	"wp_author_id" integer,
	"wp_post_id" integer,
	"wp_post_url" text,
	"wp_publish_status" varchar(20),
	"article_type" text,
	"additional_info" text,
	"nextjs_publish_status" varchar(20),
	"nextjs_published_at" timestamp with time zone,
	CONSTRAINT "uq_posts_profile_slug" UNIQUE("profile_id","slug")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	"user_id" varchar,
	CONSTRAINT "uq_settings_key_user_id" UNIQUE NULLS NOT DISTINCT("key","user_id")
);
--> statement-breakpoint
CREATE TABLE "website_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"website_url" text NOT NULL,
	"sitemap_urls" jsonb DEFAULT '[]'::jsonb,
	"niche" text,
	"target_audience" text,
	"tone" text DEFAULT 'Conversational and friendly',
	"brand_voice" text,
	"word_count" integer DEFAULT 2000,
	"output_format" varchar(20) DEFAULT 'both',
	"image_style" text,
	"image_brand_colors" jsonb DEFAULT '[]'::jsonb,
	"image_exclude" jsonb DEFAULT '[]'::jsonb,
	"avoid" text,
	"required_mentions" text,
	"related_keywords" jsonb DEFAULT '[]'::jsonb,
	"default_stage_settings" jsonb DEFAULT '{"edit":"review","write":"review","images":"review","outline":"review","research":"review"}'::jsonb,
	"last_crawled_at" timestamp with time zone,
	"crawl_status" varchar(20) DEFAULT 'pending',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"recrawl_interval" varchar(20),
	"wp_url" text,
	"wp_username" text,
	"wp_app_password" text,
	"wp_default_author_id" integer,
	"wp_default_category_id" integer,
	"wp_default_status" varchar(20) DEFAULT 'publish',
	"user_id" varchar,
	"nextjs_webhook_url" text,
	"nextjs_webhook_secret" text,
	"nextjs_frontmatter_map" json
);
--> statement-breakpoint
ALTER TABLE "internal_links" ADD CONSTRAINT "internal_links_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."website_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_links" ADD CONSTRAINT "internal_links_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."website_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_internal_links_profile" ON "internal_links" USING btree ("profile_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "ix_settings_user_id" ON "settings" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_website_profiles_user_id" ON "website_profiles" USING btree ("user_id" text_ops);