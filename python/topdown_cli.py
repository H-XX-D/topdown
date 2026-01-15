#!/usr/bin/env python3
"""
Top-Down CLI

A command-line interface for managing Top-Down configurations.

Usage:
    topdown init                    Initialize a new .topdown directory
    topdown add <name>              Add a new row
    topdown get <row-id>            Get a row by ID
    topdown list [--scope SCOPE]    List all rows
    topdown deps <row-id>           Show dependencies for a row
    topdown impact <row-id>         Show impact (what depends on this row)
    topdown validate                Validate the config
    topdown migrate <source>        Migrate from .env, YAML, or TOML
    topdown docs [--output FILE]    Generate documentation
    topdown export <format>         Export to JSON, YAML, Mermaid, or DOT
    topdown notify <webhook-url>    Send notification to Slack/Discord

Exit codes:
    0 - Success
    1 - Validation errors or command failure
    2 - Config file not found or invalid
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import string
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

try:
    import tomllib
    HAS_TOML = True
except ImportError:
    try:
        import toml as tomllib
        HAS_TOML = True
    except ImportError:
        HAS_TOML = False


TOPDOWN_DIR = ".topdown"
CONFIG_FILE = "config.json"
SCHEMA_VERSION = 1


@dataclass
class ConfigRow:
    id: str
    locked: bool = False
    name: str = ""
    args: str = ""
    expr: str = ""
    scope: Optional[str] = None
    depends: List[str] = field(default_factory=list)
    sources: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"id": self.id, "name": self.name}
        if self.locked:
            d["locked"] = True
        if self.args:
            d["args"] = self.args
        if self.expr:
            d["expr"] = self.expr
        if self.scope:
            d["scope"] = self.scope
        if self.depends:
            d["depends"] = self.depends
        if self.sources:
            d["sources"] = self.sources
        return d


@dataclass
class ValidationIssue:
    severity: str  # 'error' or 'warning'
    code: str
    message: str
    row_id: Optional[str] = None


class TopDownCLI:
    """Main CLI class for Top-Down operations."""

    def __init__(self, root: Optional[Path] = None):
        self.root = root or self._find_root()
        self.config_path = self.root / TOPDOWN_DIR / CONFIG_FILE if self.root else None
        self.rows: Dict[str, ConfigRow] = {}
        self.graph: Dict[str, Set[str]] = defaultdict(set)
        self.reverse_graph: Dict[str, Set[str]] = defaultdict(set)
        self.issues: List[ValidationIssue] = []

    def _find_root(self) -> Optional[Path]:
        """Find the project root containing .topdown/config.json."""
        env_root = os.environ.get("TOPDOWN_ROOT")
        if env_root:
            root = Path(env_root).expanduser().resolve()
            if (root / TOPDOWN_DIR / CONFIG_FILE).exists():
                return root

        current = Path.cwd()
        while current != current.parent:
            if (current / TOPDOWN_DIR / CONFIG_FILE).exists():
                return current
            current = current.parent
        return None

    def load(self) -> bool:
        """Load the config file."""
        if not self.config_path or not self.config_path.exists():
            return False

        try:
            data = json.loads(self.config_path.read_text("utf-8"))
        except (json.JSONDecodeError, IOError) as e:
            self.issues.append(ValidationIssue(
                severity="error", code="LOAD_FAILED", message=str(e)
            ))
            return False

        for r in data.get("rows", []):
            if not isinstance(r, dict) or "id" not in r or not r.get("id"):
                continue

            deps = r.get("depends", [])
            if isinstance(deps, str):
                deps = [d.strip() for d in deps.split(",") if d.strip()]

            sources = r.get("sources", [])
            if isinstance(sources, str):
                sources = [s.strip() for s in sources.split(",") if s.strip()]

            row = ConfigRow(
                id=r["id"],
                locked=bool(r.get("locked")),
                name=str(r.get("name", "")),
                args=str(r.get("args", "")),
                expr=str(r.get("expr", "")),
                scope=r.get("scope"),
                depends=deps if isinstance(deps, list) else [],
                sources=sources if isinstance(sources, list) else [],
            )
            self.rows[row.id] = row

        # Build graphs
        for row_id, row in self.rows.items():
            for dep in row.depends:
                if dep in self.rows:
                    self.graph[row_id].add(dep)
                    self.reverse_graph[dep].add(row_id)

        return True

    def save(self) -> bool:
        """Save the config file."""
        if not self.config_path:
            return False

        data = {
            "version": SCHEMA_VERSION,
            "rows": [row.to_dict() for row in self.rows.values()]
        }

        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            self.config_path.write_text(json.dumps(data, indent=2) + "\n", "utf-8")
            return True
        except IOError as e:
            print(f"ERROR: Failed to save config: {e}", file=sys.stderr)
            return False

    # =========================================================================
    # Helpers
    # =========================================================================

    def _generate_id(self) -> str:
        """Generate a short unique ID (e.g., abc1-2)."""
        while True:
            letters = ''.join(random.choices(string.ascii_lowercase, k=3))
            num1 = random.randint(1, 9)
            num2 = random.randint(1, 9)
            new_id = f"{letters}{num1}-{num2}"
            if new_id not in self.rows:
                return new_id

    def _get_transitive_deps(self, row_id: str) -> Set[str]:
        """Get all transitive dependencies."""
        deps: Set[str] = set()
        queue = list(self.graph.get(row_id, set()))
        while queue:
            dep = queue.pop(0)
            if dep not in deps:
                deps.add(dep)
                queue.extend(self.graph.get(dep, set()))
        return deps

    def _get_affected(self, row_id: str) -> Set[str]:
        """Get all rows affected by a change to this row."""
        affected: Set[str] = set()
        queue = [row_id]
        while queue:
            current = queue.pop(0)
            for dependent in self.reverse_graph.get(current, set()):
                if dependent not in affected:
                    affected.add(dependent)
                    queue.append(dependent)
        return affected

    def _detect_cycles(self) -> List[List[str]]:
        """Detect dependency cycles."""
        cycles: List[List[str]] = []
        visited: Set[str] = set()
        rec_stack: Set[str] = set()

        def dfs(node: str, path: List[str]) -> None:
            visited.add(node)
            rec_stack.add(node)
            path.append(node)

            for neighbor in self.graph.get(node, set()):
                if neighbor not in visited:
                    dfs(neighbor, path)
                elif neighbor in rec_stack:
                    cycle_start = path.index(neighbor)
                    cycles.append(path[cycle_start:] + [neighbor])

            path.pop()
            rec_stack.remove(node)

        for node in self.rows:
            if node not in visited:
                dfs(node, [])

        return cycles

    # =========================================================================
    # Commands
    # =========================================================================

    def cmd_init(self, force: bool = False) -> int:
        """Initialize a new .topdown directory."""
        target = Path.cwd() / TOPDOWN_DIR

        if target.exists() and not force:
            print(f"ERROR: {TOPDOWN_DIR} already exists. Use --force to overwrite.",
                  file=sys.stderr)
            return 1

        target.mkdir(parents=True, exist_ok=True)

        config = {"version": SCHEMA_VERSION, "rows": []}
        config_file = target / CONFIG_FILE
        config_file.write_text(json.dumps(config, indent=2) + "\n", "utf-8")

        # Create directories
        (target / "backups").mkdir(exist_ok=True)
        (target / "backups" / "auto").mkdir(exist_ok=True)

        # Create .gitignore
        gitignore = target / ".gitignore"
        gitignore.write_text("backups/auto/\n")

        print(f"Initialized Top-Down in {target}")
        print(f"  Config: {config_file}")
        print(f"  Backups: {target / 'backups'}")
        return 0

    def cmd_add(self, name: str, scope: Optional[str] = None,
                args: str = "", expr: str = "", depends: List[str] = None) -> int:
        """Add a new row."""
        if not self.load():
            if not self.root:
                print("ERROR: No Top-Down config found. Run 'topdown init' first.",
                      file=sys.stderr)
                return 1

        row_id = self._generate_id()
        row = ConfigRow(
            id=row_id,
            name=name,
            scope=scope,
            args=args,
            expr=expr,
            depends=depends or [],
        )

        self.rows[row_id] = row

        if self.save():
            print(f"Added row: {row_id}")
            print(f"  Name: {name}")
            if scope:
                print(f"  Scope: {scope}")
            return 0
        return 1

    def cmd_get(self, row_id: str) -> int:
        """Get a row by ID."""
        if not self.load():
            print("ERROR: No Top-Down config found.", file=sys.stderr)
            return 1

        row = self.rows.get(row_id)
        if not row:
            print(f"ERROR: Row '{row_id}' not found.", file=sys.stderr)
            return 1

        print(json.dumps(row.to_dict(), indent=2))
        return 0

    def cmd_list(self, scope: Optional[str] = None, format: str = "table") -> int:
        """List all rows."""
        if not self.load():
            print("ERROR: No Top-Down config found.", file=sys.stderr)
            return 1

        rows = list(self.rows.values())
        if scope:
            rows = [r for r in rows if r.scope == scope]

        if not rows:
            print("No rows found.")
            return 0

        if format == "json":
            print(json.dumps([r.to_dict() for r in rows], indent=2))
        else:
            print(f"{'ID':<12} {'Name':<30} {'Scope':<12} {'Deps':<6} {'Locked':<6}")
            print("-" * 70)
            for row in sorted(rows, key=lambda r: (r.scope or "", r.name)):
                lock = "Yes" if row.locked else ""
                scope_str = row.scope or "-"
                print(f"{row.id:<12} {row.name:<30} {scope_str:<12} "
                      f"{len(row.depends):<6} {lock:<6}")

        print(f"\nTotal: {len(rows)} rows")
        return 0

    def cmd_deps(self, row_id: str) -> int:
        """Show dependencies for a row."""
        if not self.load():
            print("ERROR: No Top-Down config found.", file=sys.stderr)
            return 1

        row = self.rows.get(row_id)
        if not row:
            print(f"ERROR: Row '{row_id}' not found.", file=sys.stderr)
            return 1

        all_deps = self._get_transitive_deps(row_id)

        print(f"Dependencies for {row_id} ({row.name}):")
        print(f"  Direct: {len(row.depends)}")
        print(f"  Transitive: {len(all_deps)}")

        if row.depends:
            print("\nDirect dependencies:")
            for dep_id in row.depends:
                dep = self.rows.get(dep_id)
                name = dep.name if dep else "(not found)"
                print(f"  -> {dep_id}: {name}")

        return 0

    def cmd_impact(self, row_id: str) -> int:
        """Show what depends on this row (impact analysis)."""
        if not self.load():
            print("ERROR: No Top-Down config found.", file=sys.stderr)
            return 1

        row = self.rows.get(row_id)
        if not row:
            print(f"ERROR: Row '{row_id}' not found.", file=sys.stderr)
            return 1

        affected = self._get_affected(row_id)

        print(f"Impact analysis for {row_id} ({row.name}):")
        print(f"  Direct dependents: {len(self.reverse_graph.get(row_id, set()))}")
        print(f"  Total affected: {len(affected)}")

        if affected:
            by_scope: Dict[str, List[str]] = defaultdict(list)
            for a in affected:
                r = self.rows.get(a)
                scope = r.scope if r else "unknown"
                by_scope[scope or "config"].append(a)

            print("\nAffected by scope:")
            for scope in sorted(by_scope.keys()):
                print(f"  [{scope}] ({len(by_scope[scope])} rows)")
                for rid in by_scope[scope][:5]:
                    r = self.rows.get(rid)
                    print(f"    -> {rid}: {r.name if r else '?'}")
                if len(by_scope[scope]) > 5:
                    print(f"    ... and {len(by_scope[scope]) - 5} more")

        return 0

    def cmd_validate(self, strict: bool = False, fail_on_cycle: bool = False,
                     fail_on_missing: bool = False, no_color: bool = False) -> int:
        """Validate the config."""
        if not self.config_path:
            config_path = self._find_root()
            if config_path:
                self.config_path = config_path / TOPDOWN_DIR / CONFIG_FILE

        if not self.config_path or not self.config_path.exists():
            print("ERROR: No Top-Down config found.", file=sys.stderr)
            return 2

        print(f"Validating: {self.config_path}")
        print()

        if not self.load():
            for issue in self.issues:
                self._print_issue(issue, not no_color)
            return 2

        errors: List[ValidationIssue] = []
        warnings: List[ValidationIssue] = []

        # Check for duplicate IDs
        seen_ids: Set[str] = set()
        for row in self.rows.values():
            if row.id in seen_ids:
                errors.append(ValidationIssue(
                    severity="error", code="DUPLICATE_ID",
                    message=f"Duplicate ID: {row.id}", row_id=row.id
                ))
            seen_ids.add(row.id)

        # Check for missing dependencies
        for row in self.rows.values():
            for dep in row.depends:
                if dep not in self.rows:
                    errors.append(ValidationIssue(
                        severity="error", code="MISSING_DEPENDENCY",
                        message=f"Row '{row.id}' depends on missing '{dep}'",
                        row_id=row.id
                    ))

        # Check for cycles
        for cycle in self._detect_cycles():
            errors.append(ValidationIssue(
                severity="error", code="CIRCULAR_DEPENDENCY",
                message=f"Cycle: {' -> '.join(cycle)}", row_id=cycle[0]
            ))

        # Check for locked rows with no dependents
        for row in self.rows.values():
            if row.locked and not self.reverse_graph.get(row.id):
                warnings.append(ValidationIssue(
                    severity="warning", code="UNUSED_LOCKED",
                    message=f"Locked row '{row.id}' has no dependents",
                    row_id=row.id
                ))

        # Print results
        if errors:
            print(f"Errors ({len(errors)}):")
            for issue in errors:
                self._print_issue(issue, not no_color)
            print()

        if warnings:
            print(f"Warnings ({len(warnings)}):")
            for issue in warnings:
                self._print_issue(issue, not no_color)
            print()

        print(f"Validated {len(self.rows)} rows: {len(errors)} errors, "
              f"{len(warnings)} warnings")

        # Determine exit code
        if strict and (errors or warnings):
            return 1
        if fail_on_cycle and any(i.code == "CIRCULAR_DEPENDENCY" for i in errors):
            return 1
        if fail_on_missing and any(i.code == "MISSING_DEPENDENCY" for i in errors):
            return 1
        if errors:
            return 1

        print("\nValidation passed!")
        return 0

    def _print_issue(self, issue: ValidationIssue, use_color: bool = True) -> None:
        if use_color:
            prefix = "\033[91mERROR\033[0m" if issue.severity == "error" else "\033[93mWARN\033[0m"
        else:
            prefix = issue.severity.upper()
        print(f"  [{prefix}] [{issue.code}] {issue.message}")

    def cmd_migrate(self, source: str, dry_run: bool = False) -> int:
        """Migrate from .env, YAML, or TOML file."""
        source_path = Path(source)
        if not source_path.exists():
            print(f"ERROR: Source file not found: {source}", file=sys.stderr)
            return 1

        suffix = source_path.suffix.lower()
        rows: List[ConfigRow] = []

        if suffix == ".env" or source_path.name == ".env":
            rows = self._migrate_from_env(source_path)
        elif suffix in (".yaml", ".yml"):
            if not HAS_YAML:
                print("ERROR: PyYAML not installed. Run: pip install pyyaml",
                      file=sys.stderr)
                return 1
            rows = self._migrate_from_yaml(source_path)
        elif suffix == ".toml":
            if not HAS_TOML:
                print("ERROR: tomllib not available. Use Python 3.11+ or: pip install toml",
                      file=sys.stderr)
                return 1
            rows = self._migrate_from_toml(source_path)
        else:
            print(f"ERROR: Unknown file type: {suffix}", file=sys.stderr)
            print("Supported: .env, .yaml, .yml, .toml")
            return 1

        if not rows:
            print("No rows to migrate.")
            return 0

        print(f"Migrating {len(rows)} rows from {source}:")
        for row in rows:
            value = row.expr or row.args or "(empty)"
            if len(value) > 40:
                value = value[:37] + "..."
            print(f"  {row.id}: {row.name} = {value}")

        if dry_run:
            print("\n[DRY RUN] No changes made.")
            return 0

        # Initialize if needed
        if not self.root:
            self.cmd_init()
            self.root = Path.cwd()
            self.config_path = self.root / TOPDOWN_DIR / CONFIG_FILE

        self.load()

        # Add migrated rows
        for row in rows:
            self.rows[row.id] = row

        if self.save():
            print(f"\nMigrated {len(rows)} rows to {self.config_path}")
            return 0
        return 1

    def _migrate_from_env(self, path: Path) -> List[ConfigRow]:
        """Migrate from .env file."""
        rows: List[ConfigRow] = []
        content = path.read_text("utf-8")

        for line in content.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            if "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")

                row = ConfigRow(
                    id=self._generate_id(),
                    name=key,
                    expr=value,
                    scope="env",
                )
                rows.append(row)
                self.rows[row.id] = row  # For ID uniqueness

        return rows

    def _migrate_from_yaml(self, path: Path) -> List[ConfigRow]:
        """Migrate from YAML file."""
        rows: List[ConfigRow] = []
        content = path.read_text("utf-8")
        data = yaml.safe_load(content)

        if not isinstance(data, dict):
            return rows

        def flatten(d: dict, prefix: str = "") -> List[Tuple[str, Any]]:
            items: List[Tuple[str, Any]] = []
            for k, v in d.items():
                key = f"{prefix}.{k}" if prefix else k
                if isinstance(v, dict):
                    items.extend(flatten(v, key))
                else:
                    items.append((key, v))
            return items

        for key, value in flatten(data):
            row = ConfigRow(
                id=self._generate_id(),
                name=key,
                expr=str(value) if value is not None else "",
                scope="config",
            )
            rows.append(row)
            self.rows[row.id] = row

        return rows

    def _migrate_from_toml(self, path: Path) -> List[ConfigRow]:
        """Migrate from TOML file."""
        rows: List[ConfigRow] = []

        if hasattr(tomllib, 'loads'):
            content = path.read_text("utf-8")
            data = tomllib.loads(content)
        else:
            with open(path, "rb") as f:
                data = tomllib.load(f)

        if not isinstance(data, dict):
            return rows

        def flatten(d: dict, prefix: str = "") -> List[Tuple[str, Any]]:
            items: List[Tuple[str, Any]] = []
            for k, v in d.items():
                key = f"{prefix}.{k}" if prefix else k
                if isinstance(v, dict):
                    items.extend(flatten(v, key))
                else:
                    items.append((key, v))
            return items

        for key, value in flatten(data):
            row = ConfigRow(
                id=self._generate_id(),
                name=key,
                expr=str(value) if value is not None else "",
                scope="config",
            )
            rows.append(row)
            self.rows[row.id] = row

        return rows

    def cmd_docs(self, output: Optional[str] = None) -> int:
        """Generate documentation."""
        if not self.load():
            print("ERROR: No Top-Down config found.", file=sys.stderr)
            return 1

        lines = [
            "# Top-Down Configuration",
            "",
            f"Generated from `.topdown/config.json`",
            "",
            f"**Total rows:** {len(self.rows)}",
            "",
        ]

        # Group by scope
        by_scope: Dict[str, List[ConfigRow]] = defaultdict(list)
        for row in self.rows.values():
            by_scope[row.scope or "config"].append(row)

        for scope in sorted(by_scope.keys()):
            scope_rows = by_scope[scope]
            lines.append(f"## {scope.title()} ({len(scope_rows)} rows)")
            lines.append("")

            for row in sorted(scope_rows, key=lambda r: r.name):
                lock_badge = " (locked)" if row.locked else ""
                lines.append(f"### `{row.id}` - {row.name}{lock_badge}")
                lines.append("")

                if row.args:
                    lines.append(f"**Args:** `{row.args}`")
                    lines.append("")

                if row.expr:
                    lines.append(f"**Expression:** `{row.expr}`")
                    lines.append("")

                if row.depends:
                    lines.append("**Depends on:**")
                    for dep in row.depends:
                        dep_row = self.rows.get(dep)
                        dep_name = dep_row.name if dep_row else "?"
                        lines.append(f"- `{dep}` ({dep_name})")
                    lines.append("")

                affected = self._get_affected(row.id)
                if affected:
                    lines.append(f"**Affects:** {len(affected)} rows")
                    lines.append("")

                lines.append("---")
                lines.append("")

        doc = "\n".join(lines)

        if output:
            Path(output).write_text(doc, "utf-8")
            print(f"Documentation written to {output}")
        else:
            print(doc)

        return 0

    def cmd_export(self, format: str, output: Optional[str] = None) -> int:
        """Export to various formats."""
        if not self.load():
            print("ERROR: No Top-Down config found.", file=sys.stderr)
            return 1

        if format == "json":
            result = json.dumps([r.to_dict() for r in self.rows.values()], indent=2)
        elif format == "yaml":
            if not HAS_YAML:
                print("ERROR: PyYAML not installed.", file=sys.stderr)
                return 1
            result = yaml.dump([r.to_dict() for r in self.rows.values()],
                              default_flow_style=False)
        elif format == "mermaid":
            result = self._export_mermaid()
        elif format == "dot":
            result = self._export_dot()
        else:
            print(f"ERROR: Unknown format: {format}", file=sys.stderr)
            print("Supported: json, yaml, mermaid, dot")
            return 1

        if output:
            Path(output).write_text(result, "utf-8")
            print(f"Exported to {output}")
        else:
            print(result)

        return 0

    def _export_mermaid(self) -> str:
        """Export to Mermaid flowchart format."""
        lines = ["graph TD"]

        for row in self.rows.values():
            label = row.name or row.id
            safe_label = label.replace('"', "'")
            if row.locked:
                lines.append(f'    {row.id}["{safe_label} (locked)"]')
            else:
                lines.append(f'    {row.id}["{safe_label}"]')

        lines.append("")

        for row in self.rows.values():
            for dep in row.depends:
                if dep in self.rows:
                    lines.append(f"    {dep} --> {row.id}")

        # Add scope subgraphs
        by_scope: Dict[str, List[str]] = defaultdict(list)
        for row in self.rows.values():
            by_scope[row.scope or "config"].append(row.id)

        lines.append("")
        for scope, ids in by_scope.items():
            if len(ids) > 1:
                lines.append(f"    subgraph {scope}")
                for rid in ids:
                    lines.append(f"        {rid}")
                lines.append("    end")

        return "\n".join(lines)

    def _export_dot(self) -> str:
        """Export to Graphviz DOT format."""
        lines = [
            "digraph TopDown {",
            "    rankdir=TB;",
            "    node [shape=box];",
            ""
        ]

        by_scope: Dict[str, List[ConfigRow]] = defaultdict(list)
        for row in self.rows.values():
            by_scope[row.scope or "config"].append(row)

        for scope, scope_rows in by_scope.items():
            safe_scope = scope.replace("-", "_")
            lines.append(f"    subgraph cluster_{safe_scope} {{")
            lines.append(f'        label="{scope}";')
            for row in scope_rows:
                label = row.name or row.id
                safe_label = label.replace('"', '\\"')
                style = ', style=filled, fillcolor=lightgray' if row.locked else ''
                lines.append(f'        {row.id} [label="{safe_label}"{style}];')
            lines.append("    }")
            lines.append("")

        for row in self.rows.values():
            for dep in row.depends:
                if dep in self.rows:
                    lines.append(f"    {dep} -> {row.id};")

        lines.append("}")
        return "\n".join(lines)

    def cmd_notify(self, webhook_url: str, message: Optional[str] = None,
                   changed_rows: List[str] = None) -> int:
        """Send notification to Slack/Discord webhook."""
        if not self.load():
            print("ERROR: No Top-Down config found.", file=sys.stderr)
            return 1

        import urllib.request
        import urllib.error

        # Build message
        if message:
            text = message
        elif changed_rows:
            affected_total: Set[str] = set()
            for rid in changed_rows:
                affected_total.update(self._get_affected(rid))

            text = "*Top-Down Config Changed*\n"
            text += f"Changed rows: {', '.join(f'`{r}`' for r in changed_rows)}\n"
            text += f"Total affected: {len(affected_total)} rows"
        else:
            text = f"*Top-Down Status*\n{len(self.rows)} rows configured"

        # Detect webhook type
        if "discord" in webhook_url.lower():
            payload = {"content": text}
        else:
            payload = {"text": text}

        try:
            req = urllib.request.Request(
                webhook_url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status in (200, 204):
                    print("Notification sent successfully")
                    return 0
                else:
                    print(f"ERROR: Webhook returned status {resp.status}",
                          file=sys.stderr)
                    return 1
        except urllib.error.URLError as e:
            print(f"ERROR: Failed to send notification: {e}", file=sys.stderr)
            return 1


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="topdown",
        description="Top-Down CLI - Manage parametric configurations",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    topdown init                    Initialize new .topdown directory
    topdown add "API Key" --scope env
    topdown list --scope config
    topdown impact abc1-2           Show what depends on row abc1-2
    topdown migrate .env            Import from .env file
    topdown docs --output CONFIG.md Generate documentation
    topdown export mermaid          Export dependency graph
        """
    )
    parser.add_argument("--version", action="version", version="topdown-cli 0.1.0")

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # init
    init_p = subparsers.add_parser("init", help="Initialize .topdown directory")
    init_p.add_argument("--force", "-f", action="store_true",
                        help="Overwrite existing")

    # add
    add_p = subparsers.add_parser("add", help="Add a new row")
    add_p.add_argument("name", help="Row name")
    add_p.add_argument("--scope", "-s", help="Scope (e.g., config, env, build)")
    add_p.add_argument("--args", "-a", default="", help="Arguments")
    add_p.add_argument("--expr", "-e", default="", help="Expression/value")
    add_p.add_argument("--depends", "-d", nargs="*", default=[],
                       help="Dependencies")

    # get
    get_p = subparsers.add_parser("get", help="Get a row by ID")
    get_p.add_argument("row_id", help="Row ID")

    # list
    list_p = subparsers.add_parser("list", help="List rows")
    list_p.add_argument("--scope", "-s", help="Filter by scope")
    list_p.add_argument("--format", "-f", choices=["table", "json"],
                        default="table")

    # deps
    deps_p = subparsers.add_parser("deps", help="Show dependencies")
    deps_p.add_argument("row_id", help="Row ID")

    # impact
    impact_p = subparsers.add_parser("impact", help="Show impact analysis")
    impact_p.add_argument("row_id", help="Row ID")

    # validate
    val_p = subparsers.add_parser("validate", help="Validate config")
    val_p.add_argument("--config", "-c", help="Path to config.json")
    val_p.add_argument("--strict", action="store_true",
                       help="Fail on any error or warning")
    val_p.add_argument("--fail-on-cycle", action="store_true",
                       help="Fail if cycles found")
    val_p.add_argument("--fail-on-missing-deps", action="store_true",
                       help="Fail if missing deps found")
    val_p.add_argument("--no-color", action="store_true",
                       help="Disable colored output")

    # migrate
    mig_p = subparsers.add_parser("migrate", help="Migrate from .env/YAML/TOML")
    mig_p.add_argument("source", help="Source file path")
    mig_p.add_argument("--dry-run", "-n", action="store_true",
                       help="Preview only")

    # docs
    docs_p = subparsers.add_parser("docs", help="Generate documentation")
    docs_p.add_argument("--output", "-o", help="Output file")

    # export
    exp_p = subparsers.add_parser("export", help="Export to format")
    exp_p.add_argument("format", choices=["json", "yaml", "mermaid", "dot"])
    exp_p.add_argument("--output", "-o", help="Output file")

    # notify
    not_p = subparsers.add_parser("notify", help="Send webhook notification")
    not_p.add_argument("webhook_url", help="Slack/Discord webhook URL")
    not_p.add_argument("--message", "-m", help="Custom message")
    not_p.add_argument("--changed", "-c", nargs="*", help="Changed row IDs")

    # info (legacy compatibility)
    info_p = subparsers.add_parser("info", help="Show config info")
    info_p.add_argument("--config", "-c", help="Path to config.json")
    info_p.add_argument("--verbose", "-v", action="store_true")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 0

    cli = TopDownCLI()

    if args.command == "init":
        return cli.cmd_init(force=args.force)
    elif args.command == "add":
        return cli.cmd_add(args.name, scope=args.scope, args=args.args,
                          expr=args.expr, depends=args.depends)
    elif args.command == "get":
        return cli.cmd_get(args.row_id)
    elif args.command == "list":
        return cli.cmd_list(scope=args.scope, format=args.format)
    elif args.command == "deps":
        return cli.cmd_deps(args.row_id)
    elif args.command == "impact":
        return cli.cmd_impact(args.row_id)
    elif args.command == "validate":
        return cli.cmd_validate(
            strict=args.strict,
            fail_on_cycle=args.fail_on_cycle,
            fail_on_missing=args.fail_on_missing_deps,
            no_color=args.no_color
        )
    elif args.command == "migrate":
        return cli.cmd_migrate(args.source, dry_run=args.dry_run)
    elif args.command == "docs":
        return cli.cmd_docs(output=args.output)
    elif args.command == "export":
        return cli.cmd_export(args.format, output=args.output)
    elif args.command == "notify":
        return cli.cmd_notify(args.webhook_url, message=args.message,
                             changed_rows=args.changed)
    elif args.command == "info":
        # Legacy compatibility - redirect to list
        return cli.cmd_list(format="table")

    return 0


if __name__ == "__main__":
    sys.exit(main())
