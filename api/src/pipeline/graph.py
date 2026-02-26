"""LangGraph pipeline graph definition.

Graph structure:
  START → research_node → research_gate → outline_node → outline_gate →
    write_node → write_gate → edit_node → edit_gate → images_node → images_gate → END
"""

from __future__ import annotations

import logging

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import START, StateGraph

from src.config import settings
from src.pipeline.gates import (
    edit_gate,
    images_gate,
    outline_gate,
    research_gate,
    write_gate,
)
from src.pipeline.stages.edit import edit_node
from src.pipeline.stages.images import images_node
from src.pipeline.stages.outline import outline_node
from src.pipeline.stages.research import research_node
from src.pipeline.stages.write import write_node
from src.pipeline.state import PipelineState

logger = logging.getLogger(__name__)


def build_graph() -> StateGraph:
    """Build the pipeline StateGraph (without compiling — no checkpointer yet)."""
    builder = StateGraph(PipelineState)

    # Add stage nodes
    builder.add_node("research_node", research_node)
    builder.add_node("outline_node", outline_node)
    builder.add_node("write_node", write_node)
    builder.add_node("edit_node", edit_node)
    builder.add_node("images_node", images_node)

    # Add gate nodes
    builder.add_node("research_gate", research_gate)
    builder.add_node("outline_gate", outline_gate)
    builder.add_node("write_gate", write_gate)
    builder.add_node("edit_gate", edit_gate)
    builder.add_node("images_gate", images_gate)

    # Wire edges: START → research → gate → outline → gate → ... → END
    builder.add_edge(START, "research_node")
    builder.add_edge("research_node", "research_gate")
    # Gates use Command(goto=...) so no explicit edges from gates needed
    builder.add_edge("outline_node", "outline_gate")
    builder.add_edge("write_node", "write_gate")
    builder.add_edge("edit_node", "edit_gate")
    builder.add_edge("images_node", "images_gate")

    return builder


def _checkpoint_db_uri() -> str:
    """Convert asyncpg URL to psycopg-compatible URI.

    langgraph-checkpoint-postgres uses psycopg (not asyncpg),
    so we need postgresql:// instead of postgresql+asyncpg://
    """
    url = settings.database_url
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def create_pipeline_graph():
    """Create and return a compiled pipeline graph with async PostgreSQL checkpointer.

    AsyncPostgresSaver.from_conn_string() returns an async context manager,
    so we enter it to get the actual saver instance, then call setup().

    Returns (graph, checkpointer_cm) — caller should keep checkpointer_cm alive
    for the duration of the graph invocation.
    """
    db_uri = _checkpoint_db_uri()
    checkpointer_cm = AsyncPostgresSaver.from_conn_string(db_uri)
    checkpointer = await checkpointer_cm.__aenter__()
    await checkpointer.setup()

    builder = build_graph()
    graph = builder.compile(checkpointer=checkpointer)

    return graph, checkpointer_cm


class PipelineGraphContext:
    """Async context manager for the compiled pipeline graph."""

    def __init__(self):
        self.graph = None
        self._checkpointer_cm = None

    async def __aenter__(self):
        self.graph, self._checkpointer_cm = await create_pipeline_graph()
        return self.graph

    async def __aexit__(self, *exc_args):
        if self._checkpointer_cm:
            await self._checkpointer_cm.__aexit__(*exc_args)
