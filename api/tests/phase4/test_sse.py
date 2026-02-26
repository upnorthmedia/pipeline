"""Tests for SSE event streaming."""

import json

import pytest
from src.api.events import publish_event

pytestmark = pytest.mark.anyio


async def test_publish_event():
    """Test the publish_event helper publishes to correct channels."""
    published = {}

    class MockRedis:
        async def publish(self, channel, message):
            published[channel] = message

    redis = MockRedis()
    await publish_event(
        redis,
        post_id="test-123",
        event="stage_completed",
        data={"stage": "research", "status": "complete"},
    )

    assert "pipeline:post:test-123" in published
    assert "pipeline:global" in published

    payload = json.loads(published["pipeline:post:test-123"])
    assert payload["event"] == "stage_completed"
    assert payload["post_id"] == "test-123"
    assert payload["stage"] == "research"


async def test_publish_event_data_serialization():
    """Verify event data is properly JSON-serialized."""
    published = {}

    class MockRedis:
        async def publish(self, channel, message):
            published[channel] = message

    redis = MockRedis()
    await publish_event(
        redis,
        post_id="abc-456",
        event="stage_started",
        data={"stage": "write", "tokens": 1500},
    )

    payload = json.loads(published["pipeline:global"])
    assert payload["tokens"] == 1500
    assert payload["event"] == "stage_started"
