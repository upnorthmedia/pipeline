const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8055";

// --- Types ---

export type StageMode = "auto";
export type StageStatus = "pending" | "running" | "complete" | "failed";
export type PipelineStage = "research" | "outline" | "write" | "edit" | "images" | "ready";
export type PostStage = PipelineStage | "pending" | "complete" | "failed" | "paused";

export const STAGES: PipelineStage[] = ["research", "outline", "write", "edit", "images", "ready"];

export type StageSettings = Record<PipelineStage, StageMode>;
export type StageStatusMap = Partial<Record<PipelineStage, StageStatus>>;

export interface Profile {
  id: string;
  name: string;
  website_url: string;
  niche: string | null;
  target_audience: string | null;
  tone: string;
  brand_voice: string | null;
  word_count: number;
  output_format: string;
  image_style: string | null;
  image_brand_colors: string[];
  image_exclude: string[];
  avoid: string | null;
  required_mentions: string | null;
  related_keywords: string[];
  default_stage_settings: StageSettings;
  sitemap_urls: string[];
  last_crawled_at: string | null;
  crawl_status: string;
  recrawl_interval: string | null;
  wp_url: string | null;
  wp_username: string | null;
  wp_default_author_id: number | null;
  wp_default_category_id: number | null;
  wp_default_status: string | null;
  nextjs_webhook_url: string | null;
  nextjs_frontmatter_map: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileCreate {
  name: string;
  website_url: string;
  niche?: string | null;
  target_audience?: string | null;
  tone?: string;
  brand_voice?: string | null;
  word_count?: number;
  output_format?: string;
  image_style?: string | null;
  image_brand_colors?: string[];
  image_exclude?: string[];
  avoid?: string | null;
  required_mentions?: string | null;
  related_keywords?: string[];
  default_stage_settings?: Partial<StageSettings>;
  recrawl_interval?: string | null;
  wp_url?: string | null;
  wp_username?: string | null;
  wp_app_password?: string | null;
  wp_default_author_id?: number | null;
  wp_default_category_id?: number | null;
  wp_default_status?: string | null;
  nextjs_webhook_url?: string | null;
  nextjs_webhook_secret?: string | null;
  nextjs_frontmatter_map?: Record<string, unknown> | null;
}

export interface WPCategory {
  id: number;
  name: string;
  slug: string;
  count: number;
}

export interface WPAuthor {
  id: number;
  name: string;
  slug: string;
}

export interface WPConnectionTest {
  connected: boolean;
  site_name?: string;
  error?: string;
}

export interface Post {
  id: string;
  slug: string;
  topic: string;
  profile_id: string | null;
  target_audience: string | null;
  niche: string | null;
  intent: string | null;
  word_count: number;
  tone: string;
  output_format: string;
  website_url: string | null;
  related_keywords: string[];
  competitor_urls: string[];
  image_style: string | null;
  image_brand_colors: string[];
  image_exclude: string[];
  brand_voice: string | null;
  avoid: string | null;
  required_mentions: string | null;
  article_type: string | null;
  additional_info: string | null;
  stage_settings: StageSettings;
  current_stage: PostStage;
  stage_status: StageStatusMap;
  stage_logs: Record<string, unknown>;
  thread_id: string | null;
  priority: number;
  research_content: string | null;
  outline_content: string | null;
  draft_content: string | null;
  final_md_content: string | null;
  final_html_content: string | null;
  image_manifest: Record<string, unknown> | null;
  ready_content: string | null;
  wp_category_id: number | null;
  wp_author_id: number | null;
  wp_post_id: number | null;
  wp_post_url: string | null;
  wp_publish_status: string | null;
  nextjs_publish_status: string | null;
  nextjs_published_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PostCreate {
  slug: string;
  topic: string;
  profile_id?: string | null;
  intent?: string | null;
  target_audience?: string | null;
  niche?: string | null;
  word_count?: number;
  tone?: string;
  output_format?: string;
  website_url?: string | null;
  related_keywords?: string[];
  competitor_urls?: string[];
  image_style?: string | null;
  image_brand_colors?: string[];
  image_exclude?: string[];
  brand_voice?: string | null;
  avoid?: string | null;
  required_mentions?: string | null;
  article_type?: string | null;
  additional_info?: string | null;
  stage_settings?: Partial<StageSettings>;
  wp_category_id?: number | null;
  wp_author_id?: number | null;
}

export interface PostUpdate {
  topic?: string;
  target_audience?: string | null;
  niche?: string | null;
  intent?: string | null;
  word_count?: number;
  tone?: string;
  output_format?: string;
  website_url?: string | null;
  related_keywords?: string[];
  competitor_urls?: string[];
  image_style?: string | null;
  image_brand_colors?: string[];
  image_exclude?: string[];
  brand_voice?: string | null;
  avoid?: string | null;
  required_mentions?: string | null;
  stage_settings?: Partial<StageSettings>;
  research_content?: string | null;
  outline_content?: string | null;
  draft_content?: string | null;
  final_md_content?: string | null;
  final_html_content?: string | null;
  ready_content?: string | null;
}

export interface InternalLink {
  id: string;
  profile_id: string;
  url: string;
  title: string | null;
  slug: string | null;
  source: string;
  post_id: string | null;
  keywords: string[];
  created_at: string;
}

export interface PaginatedLinks {
  items: InternalLink[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface QueueStatus {
  running: number;
  pending: number;
  complete: number;
  failed: number;
  paused: number;
  total: number;
}

export interface Setting {
  key: string;
  value: Record<string, unknown>;
  updated_at: string;
}

export interface RuleFile {
  name: string;
  filename: string;
  exists: boolean;
  size: number;
}

export interface RuleContent {
  name: string;
  content: string;
}

export interface ApiKeyStatus {
  provider: string;
  configured: boolean;
  source: "db" | "env" | "none";
  hint: string;
  valid: boolean | null;
}

export interface PostAnalytics {
  word_count: number;
  sentence_count: number;
  paragraph_count: number;
  avg_sentence_length: number;
  flesch_reading_ease: number;
  keyword_density: Record<string, number>;
  seo_checklist: Record<string, boolean>;
}

// --- Analytics Types ---

export interface DashboardStats {
  by_status: Record<string, number>;
  total: number;
  complete: number;
  completion_rate: number;
  avg_duration_s: number | null;
  by_profile: { name: string; count: number }[];
  over_time: { date: string; count: number }[];
  posts_today: number;
}

export interface CostAnalytics {
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost: number;
  avg_cost_per_post: number;
  by_model: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number; calls: number }>;
  by_stage: Record<string, { tokens_in: number; tokens_out: number; cost_usd: number; calls: number }>;
  by_profile: { name: string; cost_usd: number }[];
  cost_over_time: { date: string; cost_usd: number }[];
  model_costs_reference: Record<string, { input: number; output: number }>;
}

export interface ModelAnalytics {
  models: {
    model: string;
    call_count: number;
    avg_tokens_in: number;
    avg_tokens_out: number;
    avg_duration_s: number;
    total_cost: number;
  }[];
  stage_performance: {
    stage: string;
    runs: number;
    avg_duration_s: number;
    total_cost: number;
  }[];
  stage_success_rates: {
    stage: string;
    total: number;
    complete: number;
    failed: number;
    success_rate: number;
  }[];
}

export interface LogEntry {
  post_id: string;
  slug: string;
  topic: string;
  timestamp: string;
  stage: string;
  level: string;
  event: string;
  message: string;
  data: Record<string, unknown> | null;
}

export interface PaginatedLogs {
  items: LogEntry[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

// --- Fetch wrapper ---

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// --- Profiles ---

export const profiles = {
  list: () => request<Profile[]>("/api/profiles"),

  create: (data: ProfileCreate) =>
    request<Profile>("/api/profiles", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  get: (id: string) => request<Profile>(`/api/profiles/${id}`),

  update: (id: string, data: Partial<ProfileCreate>) =>
    request<Profile>(`/api/profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<void>(`/api/profiles/${id}`, { method: "DELETE" }),

  crawl: (id: string) =>
    request<{ status: string }>(`/api/profiles/${id}/crawl`, {
      method: "POST",
    }),

  links: (id: string, params?: { page?: number; per_page?: number; q?: string }) => {
    const search = new URLSearchParams();
    if (params?.page) search.set("page", String(params.page));
    if (params?.per_page) search.set("per_page", String(params.per_page));
    if (params?.q) search.set("q", params.q);
    const qs = search.toString();
    return request<PaginatedLinks>(`/api/profiles/${id}/links${qs ? `?${qs}` : ""}`);
  },

  createLink: (profileId: string, data: { url: string; title?: string; slug?: string; keywords?: string[] }) =>
    request<InternalLink>(`/api/profiles/${profileId}/links`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteLink: (profileId: string, linkId: string) =>
    request<void>(`/api/profiles/${profileId}/links/${linkId}`, { method: "DELETE" }),

  wpTest: (id: string) => request<WPConnectionTest>(`/api/profiles/${id}/wordpress/test`),
  wpCategories: (id: string) => request<WPCategory[]>(`/api/profiles/${id}/wordpress/categories`),
  wpAuthors: (id: string) => request<WPAuthor[]>(`/api/profiles/${id}/wordpress/authors`),

  nextjsTest: (id: string) =>
    request<{ connected: boolean; error?: string }>(`/api/profiles/${id}/nextjs/test`, {
      method: "POST",
    }),
};

// --- Posts ---

export const posts = {
  list: (params?: {
    status?: string;
    profile_id?: string;
    q?: string;
    sort?: string;
    order?: string;
    page?: number;
    per_page?: number;
  }) => {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.profile_id) search.set("profile_id", params.profile_id);
    if (params?.q) search.set("q", params.q);
    if (params?.sort) search.set("sort", params.sort);
    if (params?.order) search.set("order", params.order);
    if (params?.page) search.set("page", String(params.page));
    if (params?.per_page) search.set("per_page", String(params.per_page));
    const qs = search.toString();
    return request<Post[]>(`/api/posts${qs ? `?${qs}` : ""}`);
  },

  create: (data: PostCreate) =>
    request<Post>("/api/posts", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  get: (id: string) => request<Post>(`/api/posts/${id}`),

  update: (id: string, data: PostUpdate) =>
    request<Post>(`/api/posts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<void>(`/api/posts/${id}`, { method: "DELETE" }),

  duplicate: (id: string) =>
    request<Post>(`/api/posts/${id}/duplicate`, { method: "POST" }),

  batchCreate: (items: PostCreate[]) =>
    request<Post[]>("/api/posts/batch", {
      method: "POST",
      body: JSON.stringify(items),
    }),

  // Pipeline control
  run: (id: string, stage?: string) =>
    request<{ status: string; stage: string }>(`/api/posts/${id}/run${stage ? `?stage=${stage}` : ""}`, {
      method: "POST",
    }),

  runAll: (id: string) =>
    request<{ status: string; mode: string }>(`/api/posts/${id}/run-all`, {
      method: "POST",
    }),

  rerun: (id: string) =>
    request<{ status: string; mode: string; rerun_from: string }>(`/api/posts/${id}/rerun`, {
      method: "POST",
    }),

  restart: (id: string) =>
    request<{ status: string; mode: string }>(`/api/posts/${id}/restart`, {
      method: "POST",
    }),

  pause: (id: string) =>
    request<{ status: string }>(`/api/posts/${id}/pause`, {
      method: "POST",
    }),

  // Publish
  publish: (id: string) =>
    request<{ status: string }>(`/api/posts/${id}/publish`, { method: "POST" }),

  // Export
  exportMarkdown: (id: string) => `${API_BASE}/api/posts/${id}/export/markdown`,
  exportHtml: (id: string) => `${API_BASE}/api/posts/${id}/export/html`,
  exportAll: (id: string) => `${API_BASE}/api/posts/${id}/export/all`,

  // Analytics
  analytics: (id: string) => request<PostAnalytics>(`/api/posts/${id}/analytics`),
};

// --- Queue ---

export const queue = {
  status: () => request<QueueStatus>("/api/queue"),

  pauseAll: () =>
    request<{ status: string; count: number }>("/api/queue/pause-all", {
      method: "POST",
    }),

  resumeAll: () =>
    request<{ status: string; count: number }>("/api/queue/resume-all", {
      method: "POST",
    }),
};

// --- Settings ---

export const settings = {
  list: () => request<Setting[]>("/api/settings"),

  update: (data: Record<string, { value: Record<string, unknown> }>) =>
    request<Setting[]>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};

// --- API Keys ---

export const apiKeys = {
  get: () => request<Record<string, ApiKeyStatus>>("/api/settings/api-keys"),

  reveal: (provider: string) =>
    request<{ provider: string; key: string }>(
      `/api/settings/api-keys/${provider}/reveal`
    ),

  update: (keys: { anthropic?: string; perplexity?: string; gemini?: string }) =>
    request<Record<string, ApiKeyStatus>>("/api/settings/api-keys", {
      method: "PUT",
      body: JSON.stringify(keys),
    }),
};

// --- Rules ---

export const rules = {
  list: () => request<RuleFile[]>("/api/rules"),

  get: (name: string) => request<RuleContent>(`/api/rules/${name}`),

  update: (name: string, content: string) =>
    request<RuleContent>(`/api/rules/${name}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
};

// --- Analytics ---

export const analytics = {
  dashboard: (days = 30) =>
    request<DashboardStats>(`/api/analytics/dashboard?days=${days}`),

  costs: (params?: { days?: number; profile_id?: string; model?: string }) => {
    const search = new URLSearchParams();
    if (params?.days) search.set("days", String(params.days));
    if (params?.profile_id) search.set("profile_id", params.profile_id);
    if (params?.model) search.set("model", params.model);
    const qs = search.toString();
    return request<CostAnalytics>(`/api/analytics/costs${qs ? `?${qs}` : ""}`);
  },

  models: (params?: { model?: string }) => {
    const search = new URLSearchParams();
    if (params?.model) search.set("model", params.model);
    const qs = search.toString();
    return request<ModelAnalytics>(`/api/analytics/models${qs ? `?${qs}` : ""}`);
  },

  logs: (params?: {
    level?: string;
    stage?: string;
    profile_id?: string;
    q?: string;
    since?: string;
    until?: string;
    page?: number;
    per_page?: number;
  }) => {
    const search = new URLSearchParams();
    if (params?.level) search.set("level", params.level);
    if (params?.stage) search.set("stage", params.stage);
    if (params?.profile_id) search.set("profile_id", params.profile_id);
    if (params?.q) search.set("q", params.q);
    if (params?.since) search.set("since", params.since);
    if (params?.until) search.set("until", params.until);
    if (params?.page) search.set("page", String(params.page));
    if (params?.per_page) search.set("per_page", String(params.per_page));
    const qs = search.toString();
    return request<PaginatedLogs>(`/api/analytics/logs${qs ? `?${qs}` : ""}`);
  },
};

// --- SSE URL helpers ---

export const sseUrl = {
  post: (id: string) => `${API_BASE}/api/events/${id}`,
  global: () => `${API_BASE}/api/events`,
};
