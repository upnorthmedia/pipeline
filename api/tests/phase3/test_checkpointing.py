"""Tests for LangGraph checkpointing via graph.py."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from src.pipeline.graph import PipelineGraphContext, _checkpoint_db_uri, build_graph


class TestCheckpointDbUri:
    def test_converts_asyncpg_to_psycopg(self):
        with patch("src.pipeline.graph.settings") as mock_settings:
            mock_settings.database_url = (
                "postgresql+asyncpg://user:pass@localhost:5432/db"
            )
            result = _checkpoint_db_uri()
            assert result == "postgresql://user:pass@localhost:5432/db"

    def test_preserves_plain_postgresql(self):
        with patch("src.pipeline.graph.settings") as mock_settings:
            mock_settings.database_url = "postgresql://user:pass@localhost:5432/db"
            result = _checkpoint_db_uri()
            assert result == "postgresql://user:pass@localhost:5432/db"


class TestBuildGraph:
    def test_returns_state_graph(self):
        graph = build_graph()
        assert graph is not None

    def test_graph_has_all_stage_nodes(self):
        graph = build_graph()
        nodes = graph.nodes
        for name in [
            "research_node",
            "outline_node",
            "write_node",
            "edit_node",
            "images_node",
        ]:
            assert name in nodes

    def test_graph_has_all_gate_nodes(self):
        graph = build_graph()
        nodes = graph.nodes
        for name in [
            "research_gate",
            "outline_gate",
            "write_gate",
            "edit_gate",
            "images_gate",
        ]:
            assert name in nodes

    def test_graph_compiles_without_checkpointer(self):
        graph = build_graph()
        compiled = graph.compile()
        assert compiled is not None


class TestCreatePipelineGraph:
    @pytest.mark.asyncio
    async def test_creates_graph_and_checkpointer(self):
        from langgraph.checkpoint.memory import InMemorySaver

        mock_saver = InMemorySaver()
        mock_saver.setup = AsyncMock()  # Make setup() awaitable

        # from_conn_string returns an async context manager now
        mock_cm = AsyncMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_saver)
        mock_cm.__aexit__ = AsyncMock(return_value=None)

        with patch("src.pipeline.graph.AsyncPostgresSaver") as MockSaver:
            MockSaver.from_conn_string.return_value = mock_cm

            from src.pipeline.graph import create_pipeline_graph

            graph, checkpointer_cm = await create_pipeline_graph()

            MockSaver.from_conn_string.assert_called_once()
            mock_saver.setup.assert_awaited_once()
            assert graph is not None
            assert checkpointer_cm == mock_cm


class TestPipelineGraphContext:
    @pytest.mark.asyncio
    async def test_context_manager(self):
        with patch("src.pipeline.graph.create_pipeline_graph") as mock_create:
            mock_graph = MagicMock()
            mock_checkpointer = AsyncMock()
            mock_create.return_value = (mock_graph, mock_checkpointer)

            ctx = PipelineGraphContext()
            graph = await ctx.__aenter__()
            assert graph == mock_graph
            assert ctx._checkpointer_cm == mock_checkpointer

            await ctx.__aexit__(None, None, None)
