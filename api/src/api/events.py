"""SSE streaming endpoints for real-time pipeline updates."""

import asyncio
import json

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

router = APIRouter(prefix="/api/events", tags=["events"])

# Redis pub/sub channels
CHANNEL_POST_PREFIX = "pipeline:post:"
CHANNEL_GLOBAL = "pipeline:global"


async def _subscribe_and_stream(request: Request, channel: str):
    """Subscribe to a Redis pub/sub channel and yield SSE events."""
    redis = request.app.state.redis
    pubsub = redis.pubsub()
    await pubsub.subscribe(channel)

    try:
        while True:
            if await request.is_disconnected():
                break
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=1.0
            )
            if message and message["type"] == "message":
                data = message["data"]
                if isinstance(data, bytes):
                    data = data.decode("utf-8")
                try:
                    parsed = json.loads(data)
                    yield {
                        "event": parsed.get("event", "update"),
                        "data": json.dumps(parsed),
                    }
                except json.JSONDecodeError:
                    yield {"event": "update", "data": data}
            else:
                # Send keepalive comment every second if no messages
                await asyncio.sleep(0.5)
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.aclose()


@router.get("/{post_id}")
async def post_events(post_id: str, request: Request):
    """SSE stream for individual post progress updates."""
    channel = f"{CHANNEL_POST_PREFIX}{post_id}"
    return EventSourceResponse(_subscribe_and_stream(request, channel))


@router.get("")
async def global_events(request: Request):
    """SSE stream for global queue updates."""
    return EventSourceResponse(_subscribe_and_stream(request, CHANNEL_GLOBAL))


# Helper for worker to publish events
async def publish_event(redis, post_id: str, event: str, data: dict):
    """Publish an event to both post-specific and global channels."""
    payload = json.dumps({"event": event, "post_id": post_id, **data})
    await redis.publish(f"{CHANNEL_POST_PREFIX}{post_id}", payload)
    await redis.publish(CHANNEL_GLOBAL, payload)
