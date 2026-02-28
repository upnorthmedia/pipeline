"""Tests for worker graceful shutdown and configuration."""

import pytest
from src.worker import MAX_ATTEMPTS, WorkerSettings

pytestmark = pytest.mark.anyio


def test_worker_settings_max_tries():
    """Worker should be configured with correct max retry attempts."""
    assert WorkerSettings.max_tries == MAX_ATTEMPTS
    assert MAX_ATTEMPTS == 3


def test_worker_settings_retry_delay():
    """Worker retry delay should be configured."""
    assert WorkerSettings.retry_delay == 10


def test_worker_settings_job_timeout():
    """Job timeout should be 60 minutes for full pipeline runs."""
    assert WorkerSettings.job_timeout == 3600


def test_worker_settings_handle_signals():
    """Worker should handle SIGTERM/SIGINT for graceful shutdown."""
    assert WorkerSettings.handle_signals is True


def test_worker_has_pipeline_function():
    """Worker should register run_pipeline_stage function."""
    fn_names = [f.__name__ for f in WorkerSettings.functions]
    assert "run_pipeline_stage" in fn_names


def test_worker_has_crawl_function():
    """Worker should register crawl_profile_sitemap function."""
    fn_names = [f.__name__ for f in WorkerSettings.functions]
    assert "crawl_profile_sitemap" in fn_names


def test_worker_has_cron_jobs():
    """Worker should have cron jobs configured for re-crawl scheduling."""
    assert hasattr(WorkerSettings, "cron_jobs")
    assert len(WorkerSettings.cron_jobs) >= 1


def test_worker_settings_concurrency():
    """Worker max_jobs should match settings."""
    from src.config import settings

    assert WorkerSettings.max_jobs == settings.worker_max_jobs
