"""Pipeline state schema for LangGraph content generation pipeline."""

from __future__ import annotations

from typing import TypedDict

# Ordered list of pipeline stages
STAGES = ["research", "outline", "write", "edit", "images"]

# Maps stage name → Post model column for content storage
STAGE_CONTENT_MAP: dict[str, str] = {
    "research": "research_content",
    "outline": "outline_content",
    "write": "draft_content",
    "edit": "final_md_content",
    "images": "image_manifest",
}

# Maps stage name → LLM provider
STAGE_PROVIDER_MAP: dict[str, str] = {
    "research": "perplexity",
    "outline": "claude",
    "write": "claude",
    "edit": "claude",
    "images": "gemini",
}

# Maps stage name → rule file name
STAGE_RULES_MAP: dict[str, str] = {
    "research": "blog-research.md",
    "outline": "blog-outline.md",
    "write": "blog-write.md",
    "edit": "blog-edit.md",
    "images": "blog-images.md",
}

# Valid gate modes
GATE_MODES = ("auto", "review", "approve_only")

# Stage status values
STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_REVIEW = "review"
STATUS_COMPLETE = "complete"
STATUS_FAILED = "failed"


class PipelineState(TypedDict, total=False):
    """State schema for the content pipeline LangGraph."""

    # Post identity
    post_id: str
    slug: str
    profile_id: str

    # Config (from profile defaults + post-specific overrides)
    topic: str
    target_audience: str
    niche: str
    intent: str
    word_count: int
    tone: str
    output_format: str
    website_url: str
    related_keywords: list[str]
    competitor_urls: list[str]
    image_style: str
    image_brand_colors: list[str]
    image_exclude: list[str]
    brand_voice: str
    avoid: str
    required_mentions: str
    internal_links: list[dict]

    # Stage outputs
    research: str
    outline: str
    draft: str
    final_md: str
    final_html: str
    image_manifest: dict

    # Pipeline control
    current_stage: str
    stage_settings: dict[str, str]
    stage_status: dict[str, str]


def state_from_post(post, internal_links: list[dict] | None = None) -> PipelineState:
    """Build initial PipelineState from a Post ORM object."""
    return PipelineState(
        post_id=str(post.id),
        slug=post.slug,
        profile_id=str(post.profile_id) if post.profile_id else "",
        topic=post.topic or "",
        target_audience=post.target_audience or "",
        niche=post.niche or "",
        intent=post.intent or "",
        word_count=post.word_count or 2000,
        tone=post.tone or "Conversational and friendly",
        output_format=post.output_format or "both",
        website_url=post.website_url or "",
        related_keywords=post.related_keywords or [],
        competitor_urls=post.competitor_urls or [],
        image_style=post.image_style or "",
        image_brand_colors=post.image_brand_colors or [],
        image_exclude=post.image_exclude or [],
        brand_voice=post.brand_voice or "",
        avoid=post.avoid or "",
        required_mentions=post.required_mentions or "",
        internal_links=internal_links or [],
        research=post.research_content or "",
        outline=post.outline_content or "",
        draft=post.draft_content or "",
        final_md=post.final_md_content or "",
        final_html=post.final_html_content or "",
        image_manifest=post.image_manifest or {},
        current_stage=post.current_stage or "pending",
        stage_settings=post.stage_settings or {s: "review" for s in STAGES},
        stage_status=post.stage_status or {},
    )
