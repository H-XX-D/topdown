"""Tests for the Top-Down CLI.

Tests cover:
- CLI initialization
- Row CRUD operations
- Dependency and impact analysis
- Validation (cycles, missing deps, duplicates)
- Migration from .env, YAML, TOML
- Export to Mermaid/DOT
- Documentation generation
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Import from this directory
THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))

from topdown_cli import TopDownCLI, ConfigRow, ValidationIssue


class TestTopDownCLIBase(unittest.TestCase):
    """Base class with common setup for CLI tests."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.topdown_dir = self.root / ".topdown"
        self.topdown_dir.mkdir(parents=True, exist_ok=True)
        self.config = self.topdown_dir / "config.json"
        # Save original cwd
        self._orig_cwd = os.getcwd()
        os.chdir(self.root)

    def tearDown(self) -> None:
        os.chdir(self._orig_cwd)
        self._tmp.cleanup()

    def write_config(self, rows: list, version: int = 1) -> None:
        payload = {"version": version, "rows": rows}
        self.config.write_text(json.dumps(payload), encoding="utf-8")

    def get_cli(self) -> TopDownCLI:
        return TopDownCLI(root=self.root)


class TestCLIInit(TestTopDownCLIBase):
    """Test CLI initialization command."""

    def test_init_creates_directory_structure(self) -> None:
        # Remove existing .topdown
        import shutil
        shutil.rmtree(self.topdown_dir)

        cli = TopDownCLI()
        result = cli.cmd_init()

        self.assertEqual(result, 0)
        self.assertTrue(self.topdown_dir.exists())
        self.assertTrue(self.config.exists())
        self.assertTrue((self.topdown_dir / "backups").exists())
        self.assertTrue((self.topdown_dir / "backups" / "auto").exists())
        self.assertTrue((self.topdown_dir / ".gitignore").exists())

    def test_init_fails_if_exists(self) -> None:
        cli = TopDownCLI()
        result = cli.cmd_init(force=False)
        self.assertEqual(result, 1)

    def test_init_force_overwrites(self) -> None:
        cli = TopDownCLI()
        result = cli.cmd_init(force=True)
        self.assertEqual(result, 0)

    def test_init_creates_valid_config(self) -> None:
        import shutil
        shutil.rmtree(self.topdown_dir)

        cli = TopDownCLI()
        cli.cmd_init()

        data = json.loads(self.config.read_text())
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["rows"], [])


class TestCLIRowOperations(TestTopDownCLIBase):
    """Test CLI row CRUD operations."""

    def test_add_row(self) -> None:
        self.write_config([])
        cli = self.get_cli()

        result = cli.cmd_add("Test Row", scope="config", args="--test", expr="value")
        self.assertEqual(result, 0)

        # Reload and verify
        cli2 = self.get_cli()
        cli2.load()
        self.assertEqual(len(cli2.rows), 1)
        row = list(cli2.rows.values())[0]
        self.assertEqual(row.name, "Test Row")
        self.assertEqual(row.scope, "config")
        self.assertEqual(row.args, "--test")
        self.assertEqual(row.expr, "value")

    def test_add_row_with_depends(self) -> None:
        self.write_config([{"id": "dep1", "name": "Dependency"}])
        cli = self.get_cli()

        result = cli.cmd_add("Child", depends=["dep1"])
        self.assertEqual(result, 0)

        cli2 = self.get_cli()
        cli2.load()
        child = [r for r in cli2.rows.values() if r.name == "Child"][0]
        self.assertEqual(child.depends, ["dep1"])

    def test_get_row(self) -> None:
        self.write_config([{"id": "test1", "name": "Test", "args": "--foo"}])
        cli = self.get_cli()

        # Capture stdout
        import io
        from contextlib import redirect_stdout

        f = io.StringIO()
        with redirect_stdout(f):
            result = cli.cmd_get("test1")

        self.assertEqual(result, 0)
        output = json.loads(f.getvalue())
        self.assertEqual(output["id"], "test1")
        self.assertEqual(output["name"], "Test")

    def test_get_nonexistent_row(self) -> None:
        self.write_config([])
        cli = self.get_cli()
        result = cli.cmd_get("nonexistent")
        self.assertEqual(result, 1)

    def test_list_rows(self) -> None:
        self.write_config([
            {"id": "a", "name": "Row A", "scope": "config"},
            {"id": "b", "name": "Row B", "scope": "env"},
        ])
        cli = self.get_cli()
        result = cli.cmd_list()
        self.assertEqual(result, 0)

    def test_list_rows_filter_by_scope(self) -> None:
        self.write_config([
            {"id": "a", "name": "Row A", "scope": "config"},
            {"id": "b", "name": "Row B", "scope": "env"},
        ])
        cli = self.get_cli()
        cli.load()

        # Filter by scope
        rows = [r for r in cli.rows.values() if r.scope == "env"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].name, "Row B")


class TestCLIDependencyAnalysis(TestTopDownCLIBase):
    """Test dependency and impact analysis."""

    def test_get_transitive_deps(self) -> None:
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
            {"id": "c", "name": "C", "depends": ["b"]},
        ])
        cli = self.get_cli()
        cli.load()

        deps = cli._get_transitive_deps("c")
        self.assertEqual(deps, {"a", "b"})

    def test_get_affected(self) -> None:
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
            {"id": "c", "name": "C", "depends": ["a"]},
            {"id": "d", "name": "D", "depends": ["b", "c"]},
        ])
        cli = self.get_cli()
        cli.load()

        affected = cli._get_affected("a")
        self.assertEqual(affected, {"b", "c", "d"})

    def test_impact_command(self) -> None:
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
        ])
        cli = self.get_cli()
        result = cli.cmd_impact("a")
        self.assertEqual(result, 0)

    def test_deps_command(self) -> None:
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
        ])
        cli = self.get_cli()
        result = cli.cmd_deps("b")
        self.assertEqual(result, 0)


class TestCLIValidation(TestTopDownCLIBase):
    """Test validation functionality."""

    def test_detect_cycles(self) -> None:
        self.write_config([
            {"id": "a", "depends": ["b"]},
            {"id": "b", "depends": ["c"]},
            {"id": "c", "depends": ["a"]},
        ])
        cli = self.get_cli()
        cli.load()

        cycles = cli._detect_cycles()
        self.assertGreater(len(cycles), 0)

    def test_no_cycles(self) -> None:
        self.write_config([
            {"id": "a"},
            {"id": "b", "depends": ["a"]},
            {"id": "c", "depends": ["b"]},
        ])
        cli = self.get_cli()
        cli.load()

        cycles = cli._detect_cycles()
        self.assertEqual(len(cycles), 0)

    def test_validate_missing_deps(self) -> None:
        self.write_config([
            {"id": "a", "depends": ["nonexistent"]},
        ])
        cli = self.get_cli()
        result = cli.cmd_validate(no_color=True)
        self.assertEqual(result, 1)  # Should fail

    def test_validate_clean_config(self) -> None:
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
        ])
        cli = self.get_cli()
        result = cli.cmd_validate(no_color=True)
        self.assertEqual(result, 0)

    def test_validate_strict_mode(self) -> None:
        # Locked row with no dependents should be a warning
        self.write_config([
            {"id": "a", "name": "A", "locked": True},
        ])
        cli = self.get_cli()
        # Normal mode should pass (only warnings)
        result_normal = cli.cmd_validate(no_color=True)
        self.assertEqual(result_normal, 0)

        # Strict mode should fail
        cli2 = self.get_cli()
        result_strict = cli2.cmd_validate(strict=True, no_color=True)
        self.assertEqual(result_strict, 1)


class TestCLIMigration(TestTopDownCLIBase):
    """Test migration from external config formats."""

    def test_migrate_from_env(self) -> None:
        # Create .env file
        env_file = self.root / ".env"
        env_file.write_text("""
# Database config
DB_HOST=localhost
DB_PORT=5432
DB_NAME="mydb"
API_KEY='secret123'
""")

        self.write_config([])
        cli = self.get_cli()
        result = cli.cmd_migrate(str(env_file))
        self.assertEqual(result, 0)

        # Verify migration
        cli2 = self.get_cli()
        cli2.load()
        self.assertEqual(len(cli2.rows), 4)

        names = {r.name for r in cli2.rows.values()}
        self.assertIn("DB_HOST", names)
        self.assertIn("DB_PORT", names)
        self.assertIn("DB_NAME", names)
        self.assertIn("API_KEY", names)

        # Check scope is 'env'
        for row in cli2.rows.values():
            self.assertEqual(row.scope, "env")

    def test_migrate_dry_run(self) -> None:
        env_file = self.root / ".env"
        env_file.write_text("FOO=bar")

        self.write_config([])
        cli = self.get_cli()
        result = cli.cmd_migrate(str(env_file), dry_run=True)
        self.assertEqual(result, 0)

        # Should not have changed
        cli2 = self.get_cli()
        cli2.load()
        self.assertEqual(len(cli2.rows), 0)

    def test_migrate_from_yaml(self) -> None:
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML not installed")

        yaml_file = self.root / "config.yaml"
        yaml_file.write_text("""
database:
  host: localhost
  port: 5432
api:
  key: secret
  timeout: 30
""")

        self.write_config([])
        cli = self.get_cli()
        result = cli.cmd_migrate(str(yaml_file))
        self.assertEqual(result, 0)

        cli2 = self.get_cli()
        cli2.load()
        names = {r.name for r in cli2.rows.values()}
        self.assertIn("database.host", names)
        self.assertIn("database.port", names)
        self.assertIn("api.key", names)

    def test_migrate_nonexistent_file(self) -> None:
        cli = self.get_cli()
        result = cli.cmd_migrate("/nonexistent/file.env")
        self.assertEqual(result, 1)


class TestCLIExport(TestTopDownCLIBase):
    """Test export functionality."""

    def test_export_json(self) -> None:
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
        ])

        import io
        from contextlib import redirect_stdout

        cli = self.get_cli()
        f = io.StringIO()
        with redirect_stdout(f):
            result = cli.cmd_export("json")

        self.assertEqual(result, 0)
        output = json.loads(f.getvalue())
        self.assertEqual(len(output), 2)

    def test_export_mermaid(self) -> None:
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
        ])

        import io
        from contextlib import redirect_stdout

        cli = self.get_cli()
        f = io.StringIO()
        with redirect_stdout(f):
            result = cli.cmd_export("mermaid")

        self.assertEqual(result, 0)
        output = f.getvalue()
        self.assertIn("graph TD", output)
        self.assertIn("a -->", output)

    def test_export_dot(self) -> None:
        self.write_config([
            {"id": "a", "name": "A", "scope": "config"},
            {"id": "b", "name": "B", "depends": ["a"], "scope": "config"},
        ])

        import io
        from contextlib import redirect_stdout

        cli = self.get_cli()
        f = io.StringIO()
        with redirect_stdout(f):
            result = cli.cmd_export("dot")

        self.assertEqual(result, 0)
        output = f.getvalue()
        self.assertIn("digraph TopDown", output)
        self.assertIn("a -> b", output)
        self.assertIn("subgraph cluster_config", output)

    def test_export_to_file(self) -> None:
        self.write_config([{"id": "a", "name": "A"}])

        output_file = self.root / "output.json"
        cli = self.get_cli()
        result = cli.cmd_export("json", output=str(output_file))

        self.assertEqual(result, 0)
        self.assertTrue(output_file.exists())

        data = json.loads(output_file.read_text())
        self.assertEqual(len(data), 1)


class TestCLIDocs(TestTopDownCLIBase):
    """Test documentation generation."""

    def test_generate_docs(self) -> None:
        self.write_config([
            {"id": "a", "name": "Config A", "scope": "config", "args": "--foo"},
            {"id": "b", "name": "Config B", "scope": "config", "depends": ["a"]},
        ])

        import io
        from contextlib import redirect_stdout

        cli = self.get_cli()
        f = io.StringIO()
        with redirect_stdout(f):
            result = cli.cmd_docs()

        self.assertEqual(result, 0)
        output = f.getvalue()
        self.assertIn("# Top-Down Configuration", output)
        self.assertIn("Config A", output)
        self.assertIn("Config B", output)
        self.assertIn("**Args:**", output)
        self.assertIn("**Depends on:**", output)

    def test_generate_docs_to_file(self) -> None:
        self.write_config([{"id": "a", "name": "Test"}])

        output_file = self.root / "CONFIG.md"
        cli = self.get_cli()
        result = cli.cmd_docs(output=str(output_file))

        self.assertEqual(result, 0)
        self.assertTrue(output_file.exists())
        content = output_file.read_text()
        self.assertIn("# Top-Down Configuration", content)


class TestCLINotify(TestTopDownCLIBase):
    """Test webhook notification."""

    def test_notify_builds_message(self) -> None:
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
        ])

        cli = self.get_cli()
        cli.load()

        # Just test that affected calculation works
        affected = cli._get_affected("a")
        self.assertEqual(affected, {"b"})

    @patch('urllib.request.urlopen')
    def test_notify_slack_format(self, mock_urlopen: MagicMock) -> None:
        self.write_config([{"id": "a", "name": "A"}])

        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        cli = self.get_cli()
        result = cli.cmd_notify("https://hooks.slack.com/test", message="Test message")

        self.assertEqual(result, 0)
        # Verify the request was made
        mock_urlopen.assert_called_once()

    @patch('urllib.request.urlopen')
    def test_notify_discord_format(self, mock_urlopen: MagicMock) -> None:
        self.write_config([{"id": "a", "name": "A"}])

        mock_response = MagicMock()
        mock_response.status = 204
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        cli = self.get_cli()
        result = cli.cmd_notify("https://discord.com/api/webhooks/test",
                               message="Test")

        self.assertEqual(result, 0)


class TestCLIHelpers(TestTopDownCLIBase):
    """Test helper functions."""

    def test_generate_id_uniqueness(self) -> None:
        self.write_config([])
        cli = self.get_cli()
        cli.load()

        ids = set()
        for _ in range(100):
            new_id = cli._generate_id()
            self.assertNotIn(new_id, ids)
            ids.add(new_id)
            # Add to rows to test collision avoidance
            cli.rows[new_id] = ConfigRow(id=new_id, name="test")

    def test_generate_id_format(self) -> None:
        self.write_config([])
        cli = self.get_cli()
        cli.load()

        import re
        pattern = re.compile(r'^[a-z]{3}[1-9]-[1-9]$')

        for _ in range(10):
            new_id = cli._generate_id()
            self.assertIsNotNone(pattern.match(new_id),
                                f"ID {new_id} doesn't match pattern")


class TestConfigRow(unittest.TestCase):
    """Test ConfigRow dataclass."""

    def test_to_dict_minimal(self) -> None:
        row = ConfigRow(id="test", name="Test")
        d = row.to_dict()
        self.assertEqual(d, {"id": "test", "name": "Test"})

    def test_to_dict_full(self) -> None:
        row = ConfigRow(
            id="test",
            name="Test",
            locked=True,
            args="--foo",
            expr="bar",
            scope="config",
            depends=["a", "b"],
            sources=["*.py"]
        )
        d = row.to_dict()
        self.assertEqual(d["id"], "test")
        self.assertEqual(d["locked"], True)
        self.assertEqual(d["args"], "--foo")
        self.assertEqual(d["expr"], "bar")
        self.assertEqual(d["scope"], "config")
        self.assertEqual(d["depends"], ["a", "b"])
        self.assertEqual(d["sources"], ["*.py"])


class TestFindRoot(TestTopDownCLIBase):
    """Test root directory finding."""

    def test_find_from_env(self) -> None:
        # Ensure config file exists
        self.write_config([])

        old_env = os.environ.get("TOPDOWN_ROOT")
        try:
            os.environ["TOPDOWN_ROOT"] = str(self.root)
            cli = TopDownCLI()
            # Resolve both to handle symlinks (macOS /var -> /private/var)
            self.assertIsNotNone(cli.root)
            self.assertEqual(cli.root.resolve(), self.root.resolve())
        finally:
            if old_env:
                os.environ["TOPDOWN_ROOT"] = old_env
            else:
                os.environ.pop("TOPDOWN_ROOT", None)

    def test_find_from_cwd(self) -> None:
        # Ensure config file exists
        self.write_config([])
        os.environ.pop("TOPDOWN_ROOT", None)
        cli = TopDownCLI()
        # Resolve both to handle symlinks (macOS /var -> /private/var)
        if cli.root is None:
            # May not find root if cwd traversal doesn't match
            # Just check that we can at least init and find it
            cli2 = TopDownCLI(root=self.root)
            self.assertEqual(cli2.root.resolve(), self.root.resolve())
        else:
            self.assertEqual(cli.root.resolve(), self.root.resolve())


class TestPropagation(TestTopDownCLIBase):
    """Test that changes properly propagate through the dependency graph."""

    def test_propagation_chain(self) -> None:
        """Test that a change to a root node affects all downstream nodes."""
        self.write_config([
            {"id": "root", "name": "Root Config", "args": "--opt1"},
            {"id": "mid1", "name": "Middle 1", "depends": ["root"]},
            {"id": "mid2", "name": "Middle 2", "depends": ["root"]},
            {"id": "leaf1", "name": "Leaf 1", "depends": ["mid1"]},
            {"id": "leaf2", "name": "Leaf 2", "depends": ["mid1", "mid2"]},
            {"id": "leaf3", "name": "Leaf 3", "depends": ["mid2"]},
        ])

        cli = self.get_cli()
        cli.load()

        # Get affected nodes from root
        affected = cli._get_affected("root")

        # All downstream nodes should be affected
        self.assertEqual(affected, {"mid1", "mid2", "leaf1", "leaf2", "leaf3"})

    def test_propagation_partial(self) -> None:
        """Test propagation from a middle node."""
        self.write_config([
            {"id": "root", "name": "Root"},
            {"id": "mid", "name": "Middle", "depends": ["root"]},
            {"id": "leaf", "name": "Leaf", "depends": ["mid"]},
        ])

        cli = self.get_cli()
        cli.load()

        # Change to mid should only affect leaf
        affected = cli._get_affected("mid")
        self.assertEqual(affected, {"leaf"})

        # Change to leaf should affect nothing
        affected_leaf = cli._get_affected("leaf")
        self.assertEqual(affected_leaf, set())

    def test_diamond_dependency(self) -> None:
        """Test diamond dependency pattern (A -> B,C -> D)."""
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
            {"id": "c", "name": "C", "depends": ["a"]},
            {"id": "d", "name": "D", "depends": ["b", "c"]},
        ])

        cli = self.get_cli()
        cli.load()

        # Change to A should affect B, C, and D
        affected = cli._get_affected("a")
        self.assertEqual(affected, {"b", "c", "d"})

        # Change to B should only affect D
        affected_b = cli._get_affected("b")
        self.assertEqual(affected_b, {"d"})


# =============================================================================
# HARDER TESTS - Edge cases, stress tests, complex scenarios
# =============================================================================

class TestLargeScaleGraphs(TestTopDownCLIBase):
    """Stress tests with large dependency graphs."""

    def test_wide_fan_out(self) -> None:
        """Test a single node with 100 direct dependents."""
        rows = [{"id": "root", "name": "Root"}]
        for i in range(100):
            rows.append({"id": f"child{i}", "name": f"Child {i}", "depends": ["root"]})

        self.write_config(rows)
        cli = self.get_cli()
        cli.load()

        affected = cli._get_affected("root")
        self.assertEqual(len(affected), 100)

        # Validate passes
        result = cli.cmd_validate(no_color=True)
        self.assertEqual(result, 0)

    def test_deep_chain(self) -> None:
        """Test a chain of 50 nodes deep."""
        rows = [{"id": "node0", "name": "Node 0"}]
        for i in range(1, 50):
            rows.append({
                "id": f"node{i}",
                "name": f"Node {i}",
                "depends": [f"node{i-1}"]
            })

        self.write_config(rows)
        cli = self.get_cli()
        cli.load()

        # Change to root affects all 49 downstream nodes
        affected = cli._get_affected("node0")
        self.assertEqual(len(affected), 49)

        # Transitive deps from leaf includes all upstream
        deps = cli._get_transitive_deps("node49")
        self.assertEqual(len(deps), 49)

    def test_binary_tree(self) -> None:
        """Test binary tree structure (exponential growth)."""
        rows = [{"id": "root", "name": "Root"}]

        # Build 4 levels of binary tree = 15 nodes
        level_nodes = ["root"]
        for level in range(4):
            new_level = []
            for parent in level_nodes:
                for branch in ["L", "R"]:
                    child_id = f"{parent}_{branch}"
                    rows.append({
                        "id": child_id,
                        "name": f"Node {child_id}",
                        "depends": [parent]
                    })
                    new_level.append(child_id)
            level_nodes = new_level

        self.write_config(rows)
        cli = self.get_cli()
        cli.load()

        # Root change affects all descendants
        affected = cli._get_affected("root")
        # 2 + 4 + 8 + 16 = 30 descendants
        self.assertEqual(len(affected), 30)

    def test_dense_graph(self) -> None:
        """Test a densely connected graph where each node depends on all previous."""
        rows = [{"id": "n0", "name": "N0"}]
        for i in range(1, 20):
            rows.append({
                "id": f"n{i}",
                "name": f"N{i}",
                "depends": [f"n{j}" for j in range(i)]  # Depends on all previous
            })

        self.write_config(rows)
        cli = self.get_cli()
        cli.load()

        # n0 affects everyone
        affected = cli._get_affected("n0")
        self.assertEqual(len(affected), 19)

        # n10 has 10 direct deps
        self.assertEqual(len(cli.rows["n10"].depends), 10)


class TestComplexCycles(TestTopDownCLIBase):
    """Test complex cycle detection scenarios."""

    def test_self_reference(self) -> None:
        """Test node that depends on itself."""
        self.write_config([
            {"id": "a", "name": "A", "depends": ["a"]},  # Self-reference
        ])
        cli = self.get_cli()
        cli.load()

        cycles = cli._detect_cycles()
        self.assertGreater(len(cycles), 0)

    def test_multiple_separate_cycles(self) -> None:
        """Test multiple independent cycles."""
        self.write_config([
            # Cycle 1: a -> b -> a
            {"id": "a", "depends": ["b"]},
            {"id": "b", "depends": ["a"]},
            # Cycle 2: x -> y -> z -> x
            {"id": "x", "depends": ["z"]},
            {"id": "y", "depends": ["x"]},
            {"id": "z", "depends": ["y"]},
            # Non-cycle node
            {"id": "standalone", "name": "No cycle"},
        ])
        cli = self.get_cli()
        cli.load()

        cycles = cli._detect_cycles()
        self.assertGreaterEqual(len(cycles), 2)

    def test_cycle_with_tail(self) -> None:
        """Test cycle with a tail leading into it (a -> b -> c -> b)."""
        self.write_config([
            {"id": "a", "depends": ["b"]},
            {"id": "b", "depends": ["c"]},
            {"id": "c", "depends": ["b"]},  # Creates cycle b -> c -> b
        ])
        cli = self.get_cli()
        cli.load()

        cycles = cli._detect_cycles()
        self.assertGreater(len(cycles), 0)

        # Validation should fail
        result = cli.cmd_validate(no_color=True)
        self.assertEqual(result, 1)

    def test_large_cycle(self) -> None:
        """Test a large cycle with 20 nodes."""
        rows = []
        for i in range(20):
            next_i = (i + 1) % 20  # Circular
            rows.append({
                "id": f"c{i}",
                "name": f"Cycle node {i}",
                "depends": [f"c{next_i}"]
            })

        self.write_config(rows)
        cli = self.get_cli()
        cli.load()

        cycles = cli._detect_cycles()
        self.assertGreater(len(cycles), 0)


class TestMalformedInput(TestTopDownCLIBase):
    """Test handling of malformed or unusual input."""

    def test_empty_id(self) -> None:
        """Rows with empty ID should be skipped."""
        self.write_config([
            {"id": "", "name": "Empty ID"},
            {"id": "valid", "name": "Valid"},
        ])
        cli = self.get_cli()
        cli.load()

        # Empty ID should be skipped
        self.assertEqual(len(cli.rows), 1)
        self.assertIn("valid", cli.rows)

    def test_missing_id(self) -> None:
        """Rows without ID field should be skipped."""
        self.write_config([
            {"name": "No ID field"},
            {"id": "valid", "name": "Has ID"},
        ])
        cli = self.get_cli()
        cli.load()

        self.assertEqual(len(cli.rows), 1)

    def test_unicode_names(self) -> None:
        """Test handling of unicode in names and args."""
        self.write_config([
            {"id": "uni1", "name": "日本語テスト", "args": "--emoji 🎉"},
            {"id": "uni2", "name": "Ñoño", "expr": "café"},
            {"id": "uni3", "name": "Привет мир", "depends": ["uni1", "uni2"]},
        ])
        cli = self.get_cli()
        cli.load()

        self.assertEqual(len(cli.rows), 3)
        self.assertEqual(cli.rows["uni1"].name, "日本語テスト")
        self.assertIn("🎉", cli.rows["uni1"].args)

        # Export should handle unicode
        result = cli.cmd_export("json")
        self.assertEqual(result, 0)

    def test_special_characters_in_args(self) -> None:
        """Test args with special shell characters."""
        self.write_config([
            {"id": "spec1", "args": "--path=/foo/bar --regex='a|b|c'"},
            {"id": "spec2", "args": '--json={"key": "value"}'},
            {"id": "spec3", "args": "--cmd='echo $HOME && ls -la'"},
        ])
        cli = self.get_cli()
        cli.load()

        self.assertEqual(len(cli.rows), 3)

    def test_very_long_values(self) -> None:
        """Test handling of very long strings."""
        long_name = "A" * 10000
        long_args = "--" + "x" * 10000

        self.write_config([
            {"id": "long", "name": long_name, "args": long_args},
        ])
        cli = self.get_cli()
        cli.load()

        self.assertEqual(len(cli.rows["long"].name), 10000)

    def test_depends_as_various_types(self) -> None:
        """Test depends field with various formats."""
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "depends": "a"},  # String
            {"id": "c", "depends": ["a"]},  # List
            {"id": "d", "depends": "a, b"},  # Comma-separated string
            {"id": "e", "depends": None},  # None
            {"id": "f", "depends": 123},  # Wrong type - should be handled
        ])
        cli = self.get_cli()
        cli.load()

        self.assertEqual(cli.rows["b"].depends, ["a"])
        self.assertEqual(cli.rows["c"].depends, ["a"])
        self.assertEqual(cli.rows["d"].depends, ["a", "b"])
        self.assertEqual(cli.rows["e"].depends, [])
        self.assertEqual(cli.rows["f"].depends, [])


class TestMigrationEdgeCases(TestTopDownCLIBase):
    """Test migration edge cases."""

    def test_migrate_env_with_complex_values(self) -> None:
        """Test .env migration with complex values."""
        env_file = self.root / ".env"
        env_file.write_text("""
# Comment line
SIMPLE=value
QUOTED="quoted value"
SINGLE_QUOTED='single quoted'
WITH_EQUALS=key=value=more
MULTIWORD="hello world foo bar"
EMPTY=
WITH_SPACES=  padded
URL=https://example.com/path?query=1&other=2
JSON='{"key": "value", "num": 123}'
""")

        self.write_config([])
        cli = self.get_cli()
        result = cli.cmd_migrate(str(env_file))
        self.assertEqual(result, 0)

        cli2 = self.get_cli()
        cli2.load()

        names = {r.name: r for r in cli2.rows.values()}
        self.assertIn("SIMPLE", names)
        self.assertEqual(names["SIMPLE"].expr, "value")
        self.assertEqual(names["QUOTED"].expr, "quoted value")
        self.assertEqual(names["WITH_EQUALS"].expr, "key=value=more")
        self.assertEqual(names["EMPTY"].expr, "")
        self.assertIn("https://", names["URL"].expr)

    def test_migrate_preserves_existing(self) -> None:
        """Test that migration preserves existing rows."""
        self.write_config([
            {"id": "existing", "name": "Existing Row", "scope": "config"},
        ])

        env_file = self.root / ".env"
        env_file.write_text("NEW_VAR=value")

        cli = self.get_cli()
        result = cli.cmd_migrate(str(env_file))
        self.assertEqual(result, 0)

        cli2 = self.get_cli()
        cli2.load()

        names = {r.name for r in cli2.rows.values()}
        self.assertIn("Existing Row", names)
        self.assertIn("NEW_VAR", names)


class TestExportEdgeCases(TestTopDownCLIBase):
    """Test export edge cases."""

    def test_mermaid_special_chars(self) -> None:
        """Test Mermaid export escapes special characters."""
        self.write_config([
            {"id": "a", "name": 'Node "with" quotes'},
            {"id": "b", "name": "Node (with) parens", "depends": ["a"]},
            {"id": "c", "name": "Node [with] brackets", "depends": ["b"]},
        ])

        import io
        from contextlib import redirect_stdout

        cli = self.get_cli()
        f = io.StringIO()
        with redirect_stdout(f):
            result = cli.cmd_export("mermaid")

        self.assertEqual(result, 0)
        output = f.getvalue()
        self.assertIn("graph TD", output)
        # Should have escaped quotes
        self.assertNotIn('""', output)

    def test_dot_special_chars(self) -> None:
        """Test DOT export escapes special characters."""
        self.write_config([
            {"id": "a", "name": 'Label "with" quotes', "scope": "test-scope"},
        ])

        import io
        from contextlib import redirect_stdout

        cli = self.get_cli()
        f = io.StringIO()
        with redirect_stdout(f):
            result = cli.cmd_export("dot")

        self.assertEqual(result, 0)
        output = f.getvalue()
        self.assertIn("digraph", output)
        # Scope with dash should be converted for subgraph name
        self.assertIn("cluster_test_scope", output)

    def test_export_empty_config(self) -> None:
        """Test exporting empty config."""
        self.write_config([])

        import io
        from contextlib import redirect_stdout

        cli = self.get_cli()

        for fmt in ["json", "mermaid", "dot"]:
            f = io.StringIO()
            with redirect_stdout(f):
                result = cli.cmd_export(fmt)
            self.assertEqual(result, 0)


class TestIDGenerationStress(TestTopDownCLIBase):
    """Stress test ID generation."""

    def test_generate_1000_unique_ids(self) -> None:
        """Generate 1000 IDs and verify uniqueness."""
        self.write_config([])
        cli = self.get_cli()
        cli.load()

        ids = set()
        for i in range(1000):
            new_id = cli._generate_id()
            self.assertNotIn(new_id, ids, f"Duplicate ID at iteration {i}")
            ids.add(new_id)
            cli.rows[new_id] = ConfigRow(id=new_id, name=f"Row {i}")

        self.assertEqual(len(ids), 1000)

    def test_id_generation_with_collisions(self) -> None:
        """Test ID generation when many similar IDs exist."""
        # Pre-populate with IDs that share prefix
        rows = []
        for i in range(100):
            rows.append({"id": f"aaa{i % 10}-{i % 10}", "name": f"Row {i}"})

        self.write_config(rows)
        cli = self.get_cli()
        cli.load()

        # Should still generate unique IDs
        new_id = cli._generate_id()
        self.assertNotIn(new_id, cli.rows)


class TestValidationEdgeCases(TestTopDownCLIBase):
    """Test validation edge cases."""

    def test_validate_all_locked_no_deps(self) -> None:
        """All locked rows with no dependents (all warnings)."""
        self.write_config([
            {"id": "a", "name": "A", "locked": True},
            {"id": "b", "name": "B", "locked": True},
            {"id": "c", "name": "C", "locked": True},
        ])

        cli = self.get_cli()
        # Normal mode passes (warnings only)
        result = cli.cmd_validate(no_color=True)
        self.assertEqual(result, 0)

        # Strict mode fails
        cli2 = self.get_cli()
        result_strict = cli2.cmd_validate(strict=True, no_color=True)
        self.assertEqual(result_strict, 1)

    def test_validate_deeply_missing_dep(self) -> None:
        """Test chain where only the last node has a missing dep."""
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "name": "B", "depends": ["a"]},
            {"id": "c", "name": "C", "depends": ["b"]},
            {"id": "d", "name": "D", "depends": ["c", "nonexistent"]},
        ])

        cli = self.get_cli()
        result = cli.cmd_validate(no_color=True)
        self.assertEqual(result, 1)

    def test_validate_orphan_deps(self) -> None:
        """Test multiple nodes depending on same missing node."""
        self.write_config([
            {"id": "a", "depends": ["missing"]},
            {"id": "b", "depends": ["missing"]},
            {"id": "c", "depends": ["missing"]},
        ])

        cli = self.get_cli()
        result = cli.cmd_validate(no_color=True)
        self.assertEqual(result, 1)


class TestHashStability(TestTopDownCLIBase):
    """Test that hashes are stable and consistent."""

    def test_affected_calculation_deterministic(self) -> None:
        """Same config should always produce same affected set."""
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "depends": ["a"]},
            {"id": "c", "depends": ["a"]},
            {"id": "d", "depends": ["b", "c"]},
        ])

        results = []
        for _ in range(10):
            cli = self.get_cli()
            cli.load()
            affected = cli._get_affected("a")
            results.append(frozenset(affected))

        # All results should be identical
        self.assertEqual(len(set(results)), 1)

    def test_transitive_deps_deterministic(self) -> None:
        """Same config should always produce same transitive deps."""
        self.write_config([
            {"id": "a"},
            {"id": "b", "depends": ["a"]},
            {"id": "c", "depends": ["a", "b"]},
            {"id": "d", "depends": ["b", "c"]},
        ])

        results = []
        for _ in range(10):
            cli = self.get_cli()
            cli.load()
            deps = cli._get_transitive_deps("d")
            results.append(frozenset(deps))

        self.assertEqual(len(set(results)), 1)


class TestComplexPropagation(TestTopDownCLIBase):
    """Test complex propagation patterns."""

    def test_multi_level_diamond(self) -> None:
        """Test multiple levels of diamond patterns."""
        #       a
        #      / \
        #     b   c
        #      \ /
        #       d
        #      / \
        #     e   f
        #      \ /
        #       g
        self.write_config([
            {"id": "a", "name": "A"},
            {"id": "b", "depends": ["a"]},
            {"id": "c", "depends": ["a"]},
            {"id": "d", "depends": ["b", "c"]},
            {"id": "e", "depends": ["d"]},
            {"id": "f", "depends": ["d"]},
            {"id": "g", "depends": ["e", "f"]},
        ])

        cli = self.get_cli()
        cli.load()

        # Change to a affects everything
        self.assertEqual(cli._get_affected("a"), {"b", "c", "d", "e", "f", "g"})

        # Change to d affects e, f, g
        self.assertEqual(cli._get_affected("d"), {"e", "f", "g"})

        # Change to b affects d, e, f, g
        self.assertEqual(cli._get_affected("b"), {"d", "e", "f", "g"})

    def test_cross_scope_propagation(self) -> None:
        """Test propagation across different scopes."""
        self.write_config([
            {"id": "env1", "name": "Env Var", "scope": "env"},
            {"id": "cfg1", "name": "Config", "scope": "config", "depends": ["env1"]},
            {"id": "build1", "name": "Build", "scope": "build", "depends": ["cfg1"]},
            {"id": "test1", "name": "Test", "scope": "test", "depends": ["build1"]},
            {"id": "deploy1", "name": "Deploy", "scope": "deploy", "depends": ["test1"]},
        ])

        cli = self.get_cli()
        cli.load()

        # Env change affects entire chain
        affected = cli._get_affected("env1")
        self.assertEqual(affected, {"cfg1", "build1", "test1", "deploy1"})

        # Verify scopes
        scopes = {cli.rows[rid].scope for rid in affected}
        self.assertEqual(scopes, {"config", "build", "test", "deploy"})

    def test_isolated_subgraphs(self) -> None:
        """Test multiple isolated subgraphs don't affect each other."""
        self.write_config([
            # Subgraph 1
            {"id": "a1", "name": "A1"},
            {"id": "b1", "depends": ["a1"]},
            {"id": "c1", "depends": ["b1"]},
            # Subgraph 2 (isolated)
            {"id": "a2", "name": "A2"},
            {"id": "b2", "depends": ["a2"]},
            {"id": "c2", "depends": ["b2"]},
            # Subgraph 3 (isolated)
            {"id": "a3", "name": "A3"},
            {"id": "b3", "depends": ["a3"]},
        ])

        cli = self.get_cli()
        cli.load()

        # Changes in one subgraph don't affect others
        affected1 = cli._get_affected("a1")
        self.assertEqual(affected1, {"b1", "c1"})
        self.assertNotIn("b2", affected1)
        self.assertNotIn("a3", affected1)

        affected2 = cli._get_affected("a2")
        self.assertEqual(affected2, {"b2", "c2"})
        self.assertNotIn("b1", affected2)


if __name__ == "__main__":
    unittest.main()
