import type { Post, Profile, PostAnalytics, StageSettings, StageStatusMap } from "@/lib/api";

export const defaultStageSettings: StageSettings = {
  research: "review",
  outline: "review",
  write: "review",
  edit: "review",
  images: "review",
  ready: "review",
};

export function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    id: "prof-1",
    name: "Test Site",
    website_url: "https://example.com",
    niche: "Technology",
    target_audience: "Developers",
    tone: "Professional",
    brand_voice: null,
    word_count: 2000,
    output_format: "both",
    image_style: null,
    image_brand_colors: [],
    image_exclude: [],
    avoid: null,
    required_mentions: null,
    related_keywords: ["keyword1", "keyword2"],
    default_stage_settings: defaultStageSettings,
    sitemap_urls: [],
    last_crawled_at: null,
    crawl_status: "idle",
    recrawl_interval: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makePost(overrides?: Partial<Post>): Post {
  return {
    id: "post-1",
    slug: "test-post",
    topic: "Test Post Topic",
    profile_id: null,
    target_audience: "General",
    niche: "Tech",
    intent: "informational",
    word_count: 2000,
    tone: "Conversational",
    output_format: "both",
    website_url: null,
    related_keywords: ["keyword1"],
    competitor_urls: [],
    image_style: null,
    image_brand_colors: [],
    image_exclude: [],
    brand_voice: null,
    avoid: null,
    required_mentions: null,
    stage_settings: defaultStageSettings,
    current_stage: "research",
    stage_status: {},
    stage_logs: {},
    thread_id: null,
    priority: 5,
    research_content: null,
    outline_content: null,
    draft_content: null,
    final_md_content: null,
    final_html_content: null,
    image_manifest: null,
    ready_content: null,
    created_at: "2025-01-15T10:00:00Z",
    updated_at: "2025-01-15T10:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

export function makeCompletedPost(): Post {
  const stageStatus: StageStatusMap = {
    research: "complete",
    outline: "complete",
    write: "complete",
    edit: "complete",
    images: "complete",
    ready: "complete",
  };

  return makePost({
    id: "post-2",
    slug: "completed-post",
    topic: "Completed Post",
    current_stage: "complete",
    stage_status: stageStatus,
    research_content: "# Research\nResearch content here",
    outline_content: "# Outline\nOutline content here",
    draft_content: "# Draft\nDraft content here",
    final_md_content: "# Final\nFinal markdown content",
    final_html_content: "<p>Final HTML content</p>",
    image_manifest: { featured: { prompt: "A test image" } },
    completed_at: "2025-01-16T12:00:00Z",
  });
}

export function makeAnalytics(overrides?: Partial<PostAnalytics>): PostAnalytics {
  return {
    word_count: 2150,
    sentence_count: 108,
    paragraph_count: 24,
    avg_sentence_length: 19.9,
    flesch_reading_ease: 64.2,
    keyword_density: { "primary keyword": 1.5, "secondary keyword": 0.8 },
    seo_checklist: {
      title_contains_keyword: true,
      meta_description: true,
      h1_keyword: true,
      keyword_density_ok: true,
      internal_links: false,
      external_links: true,
    },
    ...overrides,
  };
}
