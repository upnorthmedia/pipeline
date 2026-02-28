"""Tests for post-edit link validation."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from src.services.link_validator import (
    strip_dead_links_html,
    validate_links,
)

PATCH_TARGET = "src.services.link_validator.httpx.AsyncClient"

pytestmark = pytest.mark.anyio


def _mock_response(status_code: int):
    resp = AsyncMock(spec=httpx.Response)
    resp.status_code = status_code
    return resp


@pytest.fixture
def mock_client():
    """Patch httpx.AsyncClient to control HTTP responses."""
    client = AsyncMock(spec=httpx.AsyncClient)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


async def test_200_keeps_link(mock_client):
    mock_client.head = AsyncMock(return_value=_mock_response(200))

    with patch(PATCH_TARGET, return_value=mock_client):
        result = await validate_links("Check [Example](https://example.com) here.")

    assert "https://example.com" in result.content
    assert "[Example](https://example.com)" in result.content
    assert result.removed == []


async def test_404_strips_link(mock_client):
    mock_client.head = AsyncMock(return_value=_mock_response(404))

    with patch(PATCH_TARGET, return_value=mock_client):
        result = await validate_links("Click [Dead Link](https://dead.com/page) now.")

    assert "https://dead.com/page" not in result.content
    assert "Click Dead Link now." == result.content
    assert len(result.removed) == 1
    assert result.removed[0].url == "https://dead.com/page"
    assert result.removed[0].status == 404


async def test_410_strips_link(mock_client):
    mock_client.head = AsyncMock(return_value=_mock_response(410))

    with patch(PATCH_TARGET, return_value=mock_client):
        content = "See [Gone](https://gone.com/removed) for details."
        result = await validate_links(content)

    assert "https://gone.com/removed" not in result.content
    assert "See Gone for details." == result.content
    assert len(result.removed) == 1
    assert result.removed[0].status == 410


async def test_timeout_keeps_link(mock_client):
    mock_client.head = AsyncMock(side_effect=httpx.TimeoutException("timed out"))

    with patch(PATCH_TARGET, return_value=mock_client):
        result = await validate_links("Visit [Slow](https://slow.com) site.")

    assert "[Slow](https://slow.com)" in result.content
    assert result.removed == []


async def test_connection_error_keeps_link(mock_client):
    mock_client.head = AsyncMock(side_effect=httpx.ConnectError("refused"))

    with patch(PATCH_TARGET, return_value=mock_client):
        result = await validate_links("Try [Down](https://down.com) later.")

    assert "[Down](https://down.com)" in result.content
    assert result.removed == []


async def test_skips_relative_links():
    content = "See [page](/about) and [other](/contact) for info."
    result = await validate_links(content)

    assert result.content == content
    assert result.removed == []


async def test_skips_anchor_links():
    content = "Jump to [section](#overview) for details."
    result = await validate_links(content)

    assert result.content == content
    assert result.removed == []


async def test_no_links_unchanged():
    content = "Plain text with no links at all."
    result = await validate_links(content)

    assert result.content == content
    assert result.removed == []


async def test_multiple_dead_links(mock_client):
    async def _head(url, **kwargs):
        if "dead" in url:
            return _mock_response(404)
        return _mock_response(200)

    mock_client.head = _head

    content = (
        "Visit [Good](https://good.com) and "
        "[Dead1](https://dead1.com) and "
        "[Dead2](https://dead2.com) links."
    )

    with patch(PATCH_TARGET, return_value=mock_client):
        result = await validate_links(content)

    assert "[Good](https://good.com)" in result.content
    assert "https://dead1.com" not in result.content
    assert "https://dead2.com" not in result.content
    assert "Dead1" in result.content
    assert "Dead2" in result.content
    assert len(result.removed) == 2


def test_strip_dead_links_html():
    html = '<p>Click <a href="https://dead.com">here</a> for info.</p>'
    result = strip_dead_links_html(html, {"https://dead.com"})

    assert result == "<p>Click here for info.</p>"


def test_html_keeps_alive_links():
    html = '<p>Visit <a href="https://alive.com">our site</a> today.</p>'
    result = strip_dead_links_html(html, {"https://dead.com"})

    assert '<a href="https://alive.com">our site</a>' in result
