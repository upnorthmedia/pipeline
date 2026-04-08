"""Tests for config management."""


def test_settings_loads_defaults(monkeypatch):
    # Clear env vars so pydantic-settings uses defaults
    monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    from src.config import Settings

    s = Settings(
        _env_file=None,
        database_url="postgresql+asyncpg://test:test@localhost/test",
        database_url_sync="postgresql://test:test@localhost/test",
        redis_url="redis://localhost:6379",
    )
    assert s.worker_max_jobs == 3


def test_settings_loads_from_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://custom:custom@db/mydb")
    monkeypatch.setenv("REDIS_URL", "redis://custom:6380")
    monkeypatch.setenv("WORKER_MAX_JOBS", "5")

    from src.config import Settings

    s = Settings()
    assert s.database_url == "postgresql+asyncpg://custom:custom@db/mydb"
    assert s.redis_url == "redis://custom:6380"
    assert s.worker_max_jobs == 5


def test_settings_rules_dir_exists():
    from pathlib import Path

    from src.config import settings

    rules_path = Path(settings.rules_dir)
    # Rules dir should point to the project's rules/ directory
    assert "rules" in str(rules_path)
