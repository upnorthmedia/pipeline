import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

# --- Website Profile Schemas ---


class ProfileBase(BaseModel):
    name: str
    website_url: str
    niche: str | None = None
    target_audience: str | None = None
    tone: str = "Conversational and friendly"
    brand_voice: str | None = None
    word_count: int = 2000
    output_format: str = "both"
    image_style: str | None = None
    image_brand_colors: list[str] = []
    image_exclude: list[str] = []
    avoid: str | None = None
    required_mentions: str | None = None
    related_keywords: list[str] = []
    default_stage_settings: dict = {
        "research": "review",
        "outline": "review",
        "write": "review",
        "edit": "review",
        "images": "review",
    }
    recrawl_interval: str | None = None


class ProfileCreate(ProfileBase):
    pass


class ProfileUpdate(BaseModel):
    name: str | None = None
    website_url: str | None = None
    niche: str | None = None
    target_audience: str | None = None
    tone: str | None = None
    brand_voice: str | None = None
    word_count: int | None = None
    output_format: str | None = None
    image_style: str | None = None
    image_brand_colors: list[str] | None = None
    image_exclude: list[str] | None = None
    avoid: str | None = None
    required_mentions: str | None = None
    related_keywords: list[str] | None = None
    default_stage_settings: dict | None = None
    recrawl_interval: str | None = None


class ProfileRead(ProfileBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sitemap_urls: list[str] = []
    last_crawled_at: datetime | None = None
    crawl_status: str = "pending"
    created_at: datetime
    updated_at: datetime


# --- Post Schemas ---


class PostBase(BaseModel):
    slug: str
    topic: str
    profile_id: uuid.UUID | None = None
    target_audience: str | None = None
    niche: str | None = None
    intent: str | None = None
    word_count: int = 2000
    tone: str = "Conversational and friendly"
    output_format: str = "both"
    website_url: str | None = None
    related_keywords: list[str] = []
    competitor_urls: list[str] = []
    image_style: str | None = None
    image_brand_colors: list[str] = []
    image_exclude: list[str] = []
    brand_voice: str | None = None
    avoid: str | None = None
    required_mentions: str | None = None
    stage_settings: dict = {
        "research": "review",
        "outline": "review",
        "write": "review",
        "edit": "review",
        "images": "review",
    }


class PostCreate(PostBase):
    pass


class PostUpdate(BaseModel):
    topic: str | None = None
    target_audience: str | None = None
    niche: str | None = None
    intent: str | None = None
    word_count: int | None = None
    tone: str | None = None
    output_format: str | None = None
    website_url: str | None = None
    related_keywords: list[str] | None = None
    competitor_urls: list[str] | None = None
    image_style: str | None = None
    image_brand_colors: list[str] | None = None
    image_exclude: list[str] | None = None
    brand_voice: str | None = None
    avoid: str | None = None
    required_mentions: str | None = None
    stage_settings: dict | None = None
    # Allow updating stage content directly
    research_content: str | None = None
    outline_content: str | None = None
    draft_content: str | None = None
    final_md_content: str | None = None
    final_html_content: str | None = None


class PostRead(PostBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    current_stage: str = "pending"
    stage_status: dict = {}
    stage_logs: dict = {}
    thread_id: str | None = None
    priority: int = 0
    research_content: str | None = None
    outline_content: str | None = None
    draft_content: str | None = None
    final_md_content: str | None = None
    final_html_content: str | None = None
    image_manifest: dict | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


# --- Internal Link Schemas ---


class LinkBase(BaseModel):
    url: str
    title: str | None = None
    slug: str | None = None
    keywords: list[str] = []


class LinkCreate(LinkBase):
    pass


class LinkRead(LinkBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    profile_id: uuid.UUID
    source: str = "sitemap"
    post_id: uuid.UUID | None = None
    created_at: datetime


# --- Setting Schemas ---


class SettingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    key: str
    value: dict
    updated_at: datetime


class SettingUpdate(BaseModel):
    value: dict
