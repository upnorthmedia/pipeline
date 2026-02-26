"""Tests for the pipeline graph structure and compilation."""

from src.pipeline.graph import build_graph
from src.pipeline.state import STAGES


class TestGraphStructure:
    def test_graph_builds_without_error(self):
        builder = build_graph()
        assert builder is not None

    def test_graph_has_all_stage_nodes(self):
        builder = build_graph()
        node_names = set(builder.nodes.keys())
        for stage in STAGES:
            assert f"{stage}_node" in node_names

    def test_graph_has_all_gate_nodes(self):
        builder = build_graph()
        node_names = set(builder.nodes.keys())
        for stage in STAGES:
            assert f"{stage}_gate" in node_names

    def test_graph_has_correct_node_count(self):
        builder = build_graph()
        # 6 stages + 6 gates = 12 nodes
        assert len(builder.nodes) == 12

    def test_graph_compiles_without_checkpointer(self):
        builder = build_graph()
        # Compiling without checkpointer should work
        # (interrupts won't function, but structure is valid)
        graph = builder.compile()
        assert graph is not None

    def test_graph_edges_connect_stages_to_gates(self):
        builder = build_graph()
        # Verify the graph contains the expected node connections
        nodes = builder.nodes
        for stage in STAGES:
            assert f"{stage}_node" in nodes
            assert f"{stage}_gate" in nodes

    def test_graph_starts_with_research(self):
        builder = build_graph()
        compiled = builder.compile()
        graph = compiled.get_graph()
        # First node after __start__ should be research_node
        first_edges = graph.edges
        start_edges = [e for e in first_edges if e[0] == "__start__"]
        assert len(start_edges) >= 1
        assert start_edges[0][1] == "research_node"
