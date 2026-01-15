#!/usr/bin/env python3
"""
Top-Down CI Integration

Analyzes git changes and reports affected targets for CI/PR workflows.
Maps changed files to Top-Down rows and computes the blast radius.

Usage:
    python topdown_ci.py --changed-files file1.c file2.c
    python topdown_ci.py --git-diff main
    python topdown_ci.py --git-diff main --format github
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple


@dataclass
class TopDownRow:
    id: str
    locked: bool = False
    name: str = ""
    args: str = ""
    expr: str = ""
    scope: Optional[str] = None
    depends: Tuple[str, ...] = ()


class TopDownCI:
    """CI integration for Top-Down configuration."""

    def __init__(self, config_path: Path):
        self.config_path = config_path
        self.rows: Dict[str, TopDownRow] = {}
        self.graph: Dict[str, Set[str]] = defaultdict(set)  # node -> dependencies
        self.reverse_graph: Dict[str, Set[str]] = defaultdict(set)  # node -> dependents
        self.file_patterns: Dict[str, List[str]] = {}  # row_id -> file patterns

    def load(self) -> bool:
        """Load and parse the config file."""
        if not self.config_path.exists():
            return False

        try:
            with open(self.config_path) as f:
                data = json.load(f)
        except (json.JSONDecodeError, IOError):
            return False

        rows = data.get("rows", [])
        for r in rows:
            if not isinstance(r, dict) or "id" not in r:
                continue

            row_id = r["id"]
            deps = r.get("depends", [])
            if isinstance(deps, str):
                deps = [d.strip() for d in deps.split(",") if d.strip()]

            self.rows[row_id] = TopDownRow(
                id=row_id,
                locked=bool(r.get("locked")),
                name=str(r.get("name", "")),
                args=str(r.get("args", "")),
                expr=str(r.get("expr", "")),
                scope=r.get("scope"),
                depends=tuple(deps),
            )

            # Extract file patterns from args
            self._extract_file_patterns(row_id, r.get("args", ""))

        # Build dependency graphs
        for row_id, row in self.rows.items():
            for dep in row.depends:
                if dep in self.rows:
                    self.graph[row_id].add(dep)
                    self.reverse_graph[dep].add(row_id)

        return True

    def _extract_file_patterns(self, row_id: str, args: str) -> None:
        """Extract file glob patterns from args field."""
        patterns = []
        for part in args.split():
            # Look for file-like patterns
            if any(c in part for c in ["*", "/"]) or part.endswith((".c", ".h", ".py", ".ts", ".js", ".go", ".rs")):
                patterns.append(part)
        if patterns:
            self.file_patterns[row_id] = patterns

    def get_affected_rows(self, changed_id: str) -> Set[str]:
        """Get all rows affected by a change (downstream propagation)."""
        affected = set()
        queue = [changed_id]

        while queue:
            current = queue.pop(0)
            for dependent in self.reverse_graph.get(current, set()):
                if dependent not in affected:
                    affected.add(dependent)
                    queue.append(dependent)

        return affected

    def map_files_to_rows(self, changed_files: List[str]) -> Dict[str, List[str]]:
        """Map changed files to the rows they affect."""
        file_to_rows: Dict[str, List[str]] = defaultdict(list)

        for filepath in changed_files:
            filepath_normalized = filepath.replace("\\", "/")

            for row_id, patterns in self.file_patterns.items():
                for pattern in patterns:
                    # Support glob patterns
                    if fnmatch.fnmatch(filepath_normalized, pattern):
                        file_to_rows[filepath].append(row_id)
                        break
                    # Support directory prefixes
                    if pattern.endswith("/*") or pattern.endswith("/*.c") or pattern.endswith("/*.py"):
                        dir_pattern = pattern.rsplit("/", 1)[0]
                        if filepath_normalized.startswith(dir_pattern + "/"):
                            file_to_rows[filepath].append(row_id)
                            break

        return dict(file_to_rows)

    def analyze_changes(self, changed_files: List[str]) -> Dict:
        """Analyze changed files and compute full impact."""
        # Map files to directly affected rows
        file_mapping = self.map_files_to_rows(changed_files)

        # Get all directly affected rows
        directly_affected = set()
        for rows in file_mapping.values():
            directly_affected.update(rows)

        # Compute transitive impact
        all_affected = set(directly_affected)
        for row_id in directly_affected:
            all_affected.update(self.get_affected_rows(row_id))

        # Group by scope
        by_scope: Dict[str, List[str]] = defaultdict(list)
        for row_id in all_affected:
            row = self.rows.get(row_id)
            scope = row.scope if row else "config"
            by_scope[scope or "config"].append(row_id)

        # Compute propagation levels
        levels = self._compute_levels(directly_affected)

        return {
            "changed_files": changed_files,
            "file_mapping": file_mapping,
            "directly_affected": sorted(directly_affected),
            "total_affected": sorted(all_affected),
            "by_scope": {k: sorted(v) for k, v in by_scope.items()},
            "propagation_levels": [[sorted(level) for level in levels]],
            "summary": {
                "files_changed": len(changed_files),
                "files_mapped": len(file_mapping),
                "direct_targets": len(directly_affected),
                "total_targets": len(all_affected),
            },
        }

    def _compute_levels(self, start_nodes: Set[str]) -> List[Set[str]]:
        """Compute propagation levels from starting nodes."""
        levels: List[Set[str]] = []
        visited = set(start_nodes)
        current_level = start_nodes.copy()

        while current_level:
            next_level = set()
            for node in current_level:
                for dependent in self.reverse_graph.get(node, set()):
                    if dependent not in visited:
                        visited.add(dependent)
                        next_level.add(dependent)
            if next_level:
                levels.append(next_level)
            current_level = next_level

        return levels

    def format_github_comment(self, analysis: Dict) -> str:
        """Format analysis as a GitHub PR comment."""
        lines = ["## Top-Down Impact Analysis", ""]

        summary = analysis["summary"]
        lines.append(f"**{summary['files_changed']}** files changed → "
                     f"**{summary['direct_targets']}** direct targets → "
                     f"**{summary['total_targets']}** total affected")
        lines.append("")

        # File mapping
        if analysis["file_mapping"]:
            lines.append("### Changed Files → Targets")
            lines.append("")
            for filepath, rows in sorted(analysis["file_mapping"].items()):
                lines.append(f"- `{filepath}` → {', '.join(f'`{r}`' for r in rows)}")
            lines.append("")

        # By scope
        if analysis["by_scope"]:
            lines.append("### Affected by Scope")
            lines.append("")
            for scope, targets in sorted(analysis["by_scope"].items()):
                if targets:
                    target_list = ", ".join(f"`{t}`" for t in targets[:5])
                    if len(targets) > 5:
                        target_list += f" (+{len(targets) - 5} more)"
                    lines.append(f"- **{scope}**: {target_list}")
            lines.append("")

        # Warnings for high-impact changes
        if summary["total_targets"] > 10:
            lines.append("### :warning: High Impact Change")
            lines.append("")
            lines.append(f"This PR affects **{summary['total_targets']}** targets. "
                         "Consider reviewing the full propagation chain.")
            lines.append("")

        lines.append("---")
        lines.append("*Generated by [Top-Down](https://github.com/anthropics/topdown)*")

        return "\n".join(lines)

    def format_json(self, analysis: Dict) -> str:
        """Format analysis as JSON."""
        return json.dumps(analysis, indent=2)

    def format_text(self, analysis: Dict) -> str:
        """Format analysis as plain text."""
        lines = ["=" * 60, "TOP-DOWN IMPACT ANALYSIS", "=" * 60, ""]

        summary = analysis["summary"]
        lines.append(f"Files changed:    {summary['files_changed']}")
        lines.append(f"Files mapped:     {summary['files_mapped']}")
        lines.append(f"Direct targets:   {summary['direct_targets']}")
        lines.append(f"Total affected:   {summary['total_targets']}")
        lines.append("")

        if analysis["file_mapping"]:
            lines.append("-" * 60)
            lines.append("FILE MAPPING")
            lines.append("-" * 60)
            for filepath, rows in sorted(analysis["file_mapping"].items()):
                lines.append(f"  {filepath}")
                for r in rows:
                    lines.append(f"    -> {r}")
            lines.append("")

        if analysis["by_scope"]:
            lines.append("-" * 60)
            lines.append("AFFECTED BY SCOPE")
            lines.append("-" * 60)
            for scope, targets in sorted(analysis["by_scope"].items()):
                if targets:
                    lines.append(f"  [{scope}] ({len(targets)} targets)")
                    for t in targets[:10]:
                        row = self.rows.get(t)
                        name = f" - {row.name}" if row and row.name else ""
                        lines.append(f"    {t}{name}")
                    if len(targets) > 10:
                        lines.append(f"    ... and {len(targets) - 10} more")
            lines.append("")

        lines.append("=" * 60)
        return "\n".join(lines)


def get_git_changed_files(base_ref: str, head_ref: str = "HEAD") -> List[str]:
    """Get list of changed files between two git refs."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", f"{base_ref}...{head_ref}"],
            capture_output=True,
            text=True,
            check=True,
        )
        files = [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]
        return files
    except subprocess.CalledProcessError:
        # Fallback to simple diff
        try:
            result = subprocess.run(
                ["git", "diff", "--name-only", base_ref, head_ref],
                capture_output=True,
                text=True,
                check=True,
            )
            return [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]
        except subprocess.CalledProcessError:
            return []


def find_config_file() -> Optional[Path]:
    """Find .topdown/config.json in current or parent directories."""
    current = Path.cwd()
    while current != current.parent:
        config = current / ".topdown" / "config.json"
        if config.exists():
            return config
        current = current.parent
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Top-Down CI Integration - Analyze PR impact"
    )
    parser.add_argument(
        "--config",
        type=Path,
        help="Path to .topdown/config.json",
    )
    parser.add_argument(
        "--changed-files",
        nargs="+",
        help="List of changed files",
    )
    parser.add_argument(
        "--git-diff",
        metavar="BASE_REF",
        help="Get changed files from git diff against BASE_REF",
    )
    parser.add_argument(
        "--head-ref",
        default="HEAD",
        help="Head ref for git diff (default: HEAD)",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json", "github"],
        default="text",
        help="Output format",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output file (default: stdout)",
    )
    parser.add_argument(
        "--fail-on-impact",
        type=int,
        metavar="N",
        help="Exit with code 1 if more than N targets affected",
    )

    args = parser.parse_args()

    # Find config
    config_path = args.config or find_config_file()
    if not config_path:
        print("ERROR: No .topdown/config.json found", file=sys.stderr)
        return 1

    # Get changed files
    changed_files: List[str] = []
    if args.changed_files:
        changed_files = args.changed_files
    elif args.git_diff:
        changed_files = get_git_changed_files(args.git_diff, args.head_ref)
        if not changed_files:
            print("No changed files found", file=sys.stderr)
            return 0

    if not changed_files:
        parser.print_help()
        return 1

    # Load and analyze
    ci = TopDownCI(config_path)
    if not ci.load():
        print(f"ERROR: Failed to load config from {config_path}", file=sys.stderr)
        return 1

    analysis = ci.analyze_changes(changed_files)

    # Format output
    if args.format == "json":
        output = ci.format_json(analysis)
    elif args.format == "github":
        output = ci.format_github_comment(analysis)
    else:
        output = ci.format_text(analysis)

    # Write output
    if args.output:
        args.output.write_text(output)
    else:
        print(output)

    # Check impact threshold
    if args.fail_on_impact is not None:
        if analysis["summary"]["total_targets"] > args.fail_on_impact:
            print(f"\nERROR: Impact threshold exceeded "
                  f"({analysis['summary']['total_targets']} > {args.fail_on_impact})",
                  file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
