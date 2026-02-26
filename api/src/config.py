from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parent.parent.parent / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Database
    database_url: str = (
        "postgresql+asyncpg://pipeline:pipeline@localhost:5432/content_pipeline"
    )
    database_url_sync: str = (
        "postgresql://pipeline:pipeline@localhost:5432/content_pipeline"
    )

    # Redis
    redis_url: str = "redis://localhost:6379"

    # LLM API Keys
    perplexity_api_key: str = ""
    anthropic_api_key: str = ""
    gemini_api_key: str = ""

    # Worker
    worker_max_jobs: int = 3

    # Rules directory (override with RULES_DIR env var in Docker)
    rules_dir: str = str(Path(__file__).resolve().parent.parent.parent / "rules")

    # Media directory for generated images
    media_dir: str = str(Path(__file__).resolve().parent.parent.parent / "media")


settings = Settings()
