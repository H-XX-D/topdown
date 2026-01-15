#!/usr/bin/env python3
"""
Workspace Orchestrator - The "Impossible" Test

Multi-project orchestration system that:
- Discovers and manages multiple Top-Down projects
- Creates cross-project dependency graphs
- Runs workflows spanning multiple projects
- Manages environments, secrets, gates, and policies
- Tracks metrics and handles alerts
- Supports multiple pipeline types

This is the ultimate stress test of Top-Down's capabilities.
"""

import argparse
import hashlib
import json
import os
import random
import subprocess
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# Add parent directories to find topdown_runtime
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))

from topdown_runtime import td, TopDownIdNotFound, TopDownRow
from topdown_cli import TopDownValidator


class Status(Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    BLOCKED = "blocked"
    WAITING_APPROVAL = "waiting_approval"


class Scope(Enum):
    CONFIG = "config"
    PROJECT = "project"
    ENVIRONMENT = "environment"
    SECRET = "secret"
    GATE = "gate"
    NOTIFICATION = "notification"
    SCHEDULE = "schedule"
    WORKFLOW = "workflow"
    PIPELINE = "pipeline"
    RESOURCE = "resource"
    METRIC = "metric"
    ALERT = "alert"
    POLICY = "policy"
    AUDIT = "audit"
    BACKUP = "backup"
    DISASTER_RECOVERY = "disaster-recovery"


@dataclass
class ExecutionResult:
    """Result of executing a single node."""
    node_id: str
    status: Status
    duration_ms: int = 0
    output: str = ""
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class WorkflowState:
    """State of workflow execution."""
    pipeline_id: str
    started_at: datetime
    status: Status = Status.PENDING
    results: List[ExecutionResult] = field(default_factory=list)
    current_node: Optional[str] = None
    blocked_by: Optional[str] = None

    def add_result(self, result: ExecutionResult) -> None:
        self.results.append(result)
        if result.status == Status.FAILED:
            self.status = Status.FAILED

    def summary(self) -> Dict[str, Any]:
        by_status = defaultdict(int)
        for r in self.results:
            by_status[r.status.value] += 1

        total_ms = sum(r.duration_ms for r in self.results)

        return {
            "pipeline": self.pipeline_id,
            "status": self.status.value,
            "started": self.started_at.isoformat(),
            "duration_ms": total_ms,
            "nodes": dict(by_status),
            "total_nodes": len(self.results),
        }


@dataclass
class Project:
    """Represents a discovered Top-Down project."""
    id: str
    name: str
    path: Path
    config_path: Path
    rows: List[TopDownRow] = field(default_factory=list)
    valid: bool = False
    errors: List[str] = field(default_factory=list)


class Orchestrator:
    """Multi-project workspace orchestrator."""

    def __init__(self, workspace_root: Optional[Path] = None):
        self.workspace_root = workspace_root or Path(".").resolve().parent
        self.nodes: Dict[str, TopDownRow] = {}
        self.graph: Dict[str, Set[str]] = defaultdict(set)
        self.reverse_graph: Dict[str, Set[str]] = defaultdict(set)
        self.projects: Dict[str, Project] = {}
        self.state: Optional[WorkflowState] = None
        self._load_orchestrator_config()
        self._discover_projects()

    def _load_orchestrator_config(self) -> None:
        """Load the orchestrator's own config."""
        config_path = Path(".topdown/config.json")
        if not config_path.exists():
            raise RuntimeError("Orchestrator config not found")

        data = json.loads(config_path.read_text())
        for row in data.get("rows", []):
            row_id = row.get("id", "")
            if not row_id:
                continue
            try:
                node = td(row_id)
                self.nodes[row_id] = node

                # Build dependency graph
                for dep in node.depends:
                    self.graph[row_id].add(dep)
                    self.reverse_graph[dep].add(row_id)
            except TopDownIdNotFound:
                pass

    def _discover_projects(self) -> None:
        """Discover and validate child projects."""
        for node_id, node in self.nodes.items():
            if node.scope != "project":
                continue

            project_path = self.workspace_root / node.expr
            config_path = project_path / ".topdown" / "config.json"

            project = Project(
                id=node_id,
                name=node.name,
                path=project_path,
                config_path=config_path,
            )

            if config_path.exists():
                validator = TopDownValidator(config_path)
                if validator.load():
                    project.rows = validator.rows
                    validator.run_all_validations()
                    project.errors = [e.message for e in validator.get_errors()]
                    project.valid = len(project.errors) == 0
                else:
                    project.errors = ["Failed to load config"]
            else:
                project.errors = [f"Config not found: {config_path}"]

            self.projects[node_id] = project

    def get_stats(self) -> Dict[str, Any]:
        """Get workspace statistics."""
        by_scope: Dict[str, int] = defaultdict(int)
        locked_count = 0

        for node in self.nodes.values():
            scope = node.scope or "config"
            by_scope[scope] += 1
            if node.locked:
                locked_count += 1

        # Count project rows
        project_rows = sum(len(p.rows) for p in self.projects.values())

        return {
            "orchestrator_nodes": len(self.nodes),
            "by_scope": dict(by_scope),
            "locked_nodes": locked_count,
            "projects": len(self.projects),
            "project_rows_total": project_rows,
            "total_managed_rows": len(self.nodes) + project_rows,
        }

    def detect_cycles(self) -> List[List[str]]:
        """Detect cycles in dependency graph."""
        cycles = []
        visited = set()
        rec_stack = set()

        def dfs(node: str, path: List[str]) -> None:
            visited.add(node)
            rec_stack.add(node)
            path.append(node)

            for dep in self.graph.get(node, set()):
                if dep not in visited:
                    dfs(dep, path)
                elif dep in rec_stack:
                    cycle_start = path.index(dep)
                    cycles.append(path[cycle_start:] + [dep])

            path.pop()
            rec_stack.remove(node)

        for node in self.nodes:
            if node not in visited:
                dfs(node, [])

        return cycles

    def get_transitive_deps(self, node_id: str) -> Set[str]:
        """Get all transitive dependencies."""
        deps = set()
        queue = list(self.graph.get(node_id, set()))

        while queue:
            dep = queue.pop(0)
            if dep not in deps and dep in self.nodes:
                deps.add(dep)
                queue.extend(self.graph.get(dep, set()))

        return deps

    def get_affected_nodes(self, changed_id: str) -> Set[str]:
        """Get all nodes affected by a change (propagation targets)."""
        affected = set()
        queue = [changed_id]

        while queue:
            current = queue.pop(0)
            for dependent in self.reverse_graph.get(current, set()):
                if dependent not in affected:
                    affected.add(dependent)
                    queue.append(dependent)

        return affected

    def compute_node_hash(self, node_id: str, dep_hashes: Optional[Dict[str, str]] = None) -> str:
        """Compute hash for a node including dependency hashes."""
        node = self.nodes.get(node_id)
        if not node:
            return ""

        if dep_hashes is None:
            dep_hashes = {}

        # Recursively compute dependency hashes
        dep_hash_parts = []
        for dep in sorted(node.depends):
            if dep in dep_hashes:
                dep_hash_parts.append(f"{dep}:{dep_hashes[dep]}")
            elif dep in self.nodes:
                dep_hash = self.compute_node_hash(dep, dep_hashes)
                dep_hashes[dep] = dep_hash
                dep_hash_parts.append(f"{dep}:{dep_hash}")

        parts = [
            node.args or "",
            node.expr or "",
            "|".join(dep_hash_parts),
        ]
        return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]

    def test_propagation(self, node_id: str) -> bool:
        """Test that changes to a node properly propagate to all dependents."""
        if node_id not in self.nodes:
            print(f"ERROR: Node '{node_id}' not found")
            return False

        node = self.nodes[node_id]
        affected = self.get_affected_nodes(node_id)

        print(f"\n{'=' * 70}")
        print(f"PROPAGATION TEST: {node_id}")
        print(f"{'=' * 70}")

        print(f"\nSource node: {node_id}")
        print(f"  Name: {node.name}")
        print(f"  Scope: {node.scope or 'config'}")
        print(f"  Current hash: {self.compute_node_hash(node_id)}")

        if not affected:
            print(f"\n  No dependents - nothing to propagate")
            return True

        # Compute current hashes
        print(f"\nAffected nodes ({len(affected)}):")
        current_hashes: Dict[str, str] = {}
        by_scope: Dict[str, List[str]] = defaultdict(list)

        for n in sorted(affected):
            h = self.compute_node_hash(n)
            current_hashes[n] = h
            target = self.nodes.get(n)
            scope = target.scope if target else "unknown"
            by_scope[scope].append(n)

        for scope in sorted(by_scope.keys()):
            print(f"  [{scope}]: {len(by_scope[scope])} nodes")

        # Simulate change
        print(f"\n{'=' * 70}")
        print("SIMULATING CHANGE")
        print(f"{'=' * 70}")

        original = self.nodes[node_id]
        modified = TopDownRow(
            id=original.id,
            locked=original.locked,
            name=original.name,
            args=(original.args or "") + " --modified",
            expr=original.expr,
            scope=original.scope,
            depends=original.depends,
        )
        self.nodes[node_id] = modified

        new_source_hash = self.compute_node_hash(node_id)
        print(f"\nModified {node_id}:")
        print(f"  New hash: {new_source_hash}")

        # Check propagation
        propagated = 0
        failed_nodes = []

        for n in sorted(affected):
            old_hash = current_hashes[n]
            new_hash = self.compute_node_hash(n)
            if old_hash != new_hash:
                propagated += 1
            else:
                failed_nodes.append(n)

        # Restore
        self.nodes[node_id] = original

        # Summary
        print(f"\n{'=' * 70}")
        print("PROPAGATION RESULTS")
        print(f"{'=' * 70}")
        print(f"  Source: {node_id}")
        print(f"  Direct dependents: {len(self.reverse_graph.get(node_id, set()))}")
        print(f"  Total affected: {len(affected)}")
        print(f"  Successfully propagated: {propagated}")

        success = propagated == len(affected)
        print(f"  Propagation working: {'YES' if success else 'NO'}")

        if success:
            print(f"\n  All {len(affected)} dependent nodes would be invalidated!")
        else:
            print(f"\n  WARNING: {len(failed_nodes)} nodes did not propagate:")
            for n in failed_nodes[:10]:
                print(f"    - {n}")

        return success

    def show_propagation_chain(self, node_id: str) -> None:
        """Show the propagation chain from a node."""
        if node_id not in self.nodes:
            print(f"ERROR: Node '{node_id}' not found")
            return

        print(f"\n{'=' * 70}")
        print(f"PROPAGATION CHAIN: {node_id}")
        print(f"{'=' * 70}")

        # BFS by levels
        levels: List[Set[str]] = []
        visited = {node_id}
        current_level = {node_id}

        while current_level:
            next_level = set()
            for n in current_level:
                for dependent in self.reverse_graph.get(n, set()):
                    if dependent not in visited:
                        visited.add(dependent)
                        next_level.add(dependent)
            if next_level:
                levels.append(next_level)
            current_level = next_level

        node = self.nodes[node_id]
        print(f"\nSource: {node_id} [{node.scope}]")
        print(f"  {node.name}")

        for i, level in enumerate(levels):
            by_scope: Dict[str, List[str]] = defaultdict(list)
            for n in level:
                target = self.nodes.get(n)
                scope = target.scope if target else "unknown"
                by_scope[scope].append(n)

            print(f"\nLevel {i + 1} ({len(level)} nodes):")
            for scope in sorted(by_scope.keys()):
                nodes = by_scope[scope]
                print(f"  [{scope}] ({len(nodes)}):")
                for n in sorted(nodes)[:5]:
                    target = self.nodes.get(n)
                    lock = " LOCKED" if target and target.locked else ""
                    print(f"    -> {n}{lock}")
                if len(nodes) > 5:
                    print(f"    ... and {len(nodes) - 5} more")

        total = sum(len(l) for l in levels)
        print(f"\nTotal propagation reach: {total} nodes across {len(levels)} levels")

    def get_execution_levels(self, targets: List[str]) -> List[List[str]]:
        """Get nodes in execution order by levels."""
        # Collect all targets and their transitive deps
        all_nodes = set(targets)
        for t in targets:
            all_nodes.update(self.get_transitive_deps(t))

        # Filter to only existing nodes
        all_nodes = {n for n in all_nodes if n in self.nodes}

        # Compute in-degrees
        in_degree = {n: 0 for n in all_nodes}
        for n in all_nodes:
            for dep in self.graph.get(n, set()):
                if dep in all_nodes:
                    in_degree[n] += 1

        # Kahn's algorithm by levels
        levels = []
        remaining = set(all_nodes)

        while remaining:
            level = [n for n in remaining if in_degree[n] == 0]
            if not level:
                break  # Cycle

            levels.append(sorted(level))

            for n in level:
                remaining.remove(n)
                for dependent in self.reverse_graph.get(n, set()):
                    if dependent in remaining:
                        in_degree[dependent] -= 1

        return levels

    def execute_node(self, node_id: str, dry_run: bool = False,
                    auto_approve: bool = False) -> ExecutionResult:
        """Execute a single node."""
        node = self.nodes.get(node_id)
        if not node:
            return ExecutionResult(
                node_id=node_id,
                status=Status.FAILED,
                error="Node not found"
            )

        scope = node.scope or "config"

        # Check if it's a gate requiring approval
        if scope == "gate" and node.locked and not auto_approve:
            return ExecutionResult(
                node_id=node_id,
                status=Status.WAITING_APPROVAL,
                output="Requires manual approval"
            )

        # Check if it's a locked node requiring confirmation
        if node.locked and not dry_run and not auto_approve:
            print(f"    LOCKED node requires confirmation")
            confirm = input(f"    Type 'yes' to proceed with {node_id}: ")
            if confirm.lower() != 'yes':
                return ExecutionResult(
                    node_id=node_id,
                    status=Status.SKIPPED,
                    output="Not confirmed"
                )

        if dry_run:
            return ExecutionResult(
                node_id=node_id,
                status=Status.SUCCESS,
                duration_ms=0,
                output=f"[DRY RUN] Would execute {node_id}"
            )

        # Simulate execution based on scope
        base_times = {
            "project": 100,
            "workflow": 500,
            "gate": 50,
            "notification": 100,
            "resource": 200,
            "secret": 150,
            "backup": 1000,
            "audit": 100,
        }

        duration = random.randint(
            base_times.get(scope, 50),
            base_times.get(scope, 50) * 2
        )

        # Simulate occasional failures (1% chance)
        if random.random() < 0.01:
            return ExecutionResult(
                node_id=node_id,
                status=Status.FAILED,
                duration_ms=duration,
                error="Simulated failure"
            )

        return ExecutionResult(
            node_id=node_id,
            status=Status.SUCCESS,
            duration_ms=duration,
            output=f"Completed: {node.name}"
        )

    def run_pipeline(self, pipeline_id: str, dry_run: bool = False,
                    auto_approve: bool = False, verbose: bool = False) -> bool:
        """Run a pipeline and all its dependencies."""
        if pipeline_id not in self.nodes:
            print(f"ERROR: Pipeline '{pipeline_id}' not found")
            return False

        pipeline = self.nodes[pipeline_id]
        if pipeline.scope != "pipeline":
            print(f"ERROR: '{pipeline_id}' is not a pipeline (scope: {pipeline.scope})")
            return False

        # Validate
        cycles = self.detect_cycles()
        if cycles:
            print("\nERROR: Circular dependencies detected!")
            for cycle in cycles[:3]:
                print(f"  {' -> '.join(cycle)}")
            return False

        # Initialize state
        self.state = WorkflowState(
            pipeline_id=pipeline_id,
            started_at=datetime.now(),
        )

        # Get execution plan
        levels = self.get_execution_levels([pipeline_id])

        # Count by scope
        scope_counts: Dict[str, int] = defaultdict(int)
        for level in levels:
            for node_id in level:
                node = self.nodes.get(node_id)
                if node:
                    scope_counts[node.scope or "config"] += 1

        # Header
        total_nodes = sum(len(level) for level in levels)
        print(f"\n{'=' * 70}")
        print(f"ORCHESTRATOR - Pipeline: {pipeline.name}")
        print(f"{'=' * 70}")
        print(f"\nPipeline: {pipeline_id}")
        print(f"Total nodes: {total_nodes} across {len(levels)} levels")
        print(f"\nNodes by scope:")
        for scope, count in sorted(scope_counts.items()):
            print(f"  {scope}: {count}")

        # Show execution plan
        print(f"\n{'=' * 70}")
        print("EXECUTION PLAN")
        print(f"{'=' * 70}")

        for i, level in enumerate(levels):
            parallel = " [parallel]" if len(level) > 1 else ""
            print(f"\nLevel {i + 1}{parallel}:")
            for node_id in level:
                node = self.nodes.get(node_id)
                if node:
                    lock = " LOCKED" if node.locked else ""
                    scope = node.scope or "config"
                    print(f"  [{scope}] {node_id}{lock}")
                    if verbose and node.depends:
                        print(f"         <- {', '.join(node.depends)}")

        print(f"\n{'=' * 70}")
        print("EXECUTION")
        print(f"{'=' * 70}")

        # Execute level by level
        failed_nodes: Set[str] = set()

        for level_idx, level in enumerate(levels):
            print(f"\n--- Level {level_idx + 1}/{len(levels)} ---")

            for node_id in level:
                node = self.nodes.get(node_id)
                if not node:
                    continue

                # Skip if dependency failed
                deps = self.graph.get(node_id, set())
                if deps & failed_nodes:
                    print(f"\n  SKIP [{node.scope}] {node_id} (dependency failed)")
                    self.state.add_result(ExecutionResult(
                        node_id=node_id,
                        status=Status.SKIPPED,
                    ))
                    continue

                self.state.current_node = node_id
                scope = node.scope or "config"
                lock = " LOCKED" if node.locked else ""

                print(f"\n  [{scope.upper()}] {node.name}{lock}")
                print(f"    ID: {node_id}")

                if verbose:
                    print(f"    Args: {node.args or '(none)'}")

                result = self.execute_node(
                    node_id,
                    dry_run=dry_run,
                    auto_approve=auto_approve
                )
                self.state.add_result(result)

                if result.status == Status.WAITING_APPROVAL:
                    print(f"    WAITING APPROVAL")
                    self.state.blocked_by = node_id
                    # In real system, would pause here
                    continue

                if result.status == Status.FAILED:
                    print(f"    FAILED: {result.error}")
                    failed_nodes.add(node_id)
                    continue

                if result.status == Status.SKIPPED:
                    print(f"    SKIPPED: {result.output}")
                    continue

                status_str = "OK" if not dry_run else "DRY RUN"
                print(f"    {status_str} ({result.duration_ms}ms)")

        # Summary
        self._print_summary()

        return len(failed_nodes) == 0

    def _print_summary(self) -> None:
        """Print execution summary."""
        if not self.state:
            return

        summary = self.state.summary()

        print(f"\n{'=' * 70}")
        print("EXECUTION SUMMARY")
        print(f"{'=' * 70}")
        print(f"  Pipeline: {summary['pipeline']}")
        print(f"  Status: {summary['status'].upper()}")
        print(f"  Duration: {summary['duration_ms'] / 1000:.2f}s")
        print(f"  Total nodes: {summary['total_nodes']}")
        print(f"\n  By status:")
        for status, count in summary['nodes'].items():
            print(f"    {status}: {count}")

        if self.state.blocked_by:
            print(f"\n  BLOCKED BY: {self.state.blocked_by}")

    def validate_all(self) -> bool:
        """Validate orchestrator and all projects."""
        print(f"\n{'=' * 70}")
        print("VALIDATION")
        print(f"{'=' * 70}")

        all_valid = True

        # Validate orchestrator
        print(f"\nOrchestrator config:")
        config_path = Path(".topdown/config.json")
        validator = TopDownValidator(config_path)
        if validator.load():
            validator.run_all_validations()
            errors = validator.get_errors()
            warnings = validator.get_warnings()

            print(f"  Rows: {len(validator.rows)}")
            if errors:
                print(f"  Errors: {len(errors)}")
                for e in errors[:5]:
                    print(f"    - {e.message}")
                all_valid = False
            else:
                print(f"  Status: VALID")

            # Check for cycles
            cycles = self.detect_cycles()
            if cycles:
                print(f"  Cycles detected: {len(cycles)}")
                all_valid = False
        else:
            print(f"  Failed to load!")
            all_valid = False

        # Validate each project
        print(f"\nProjects ({len(self.projects)}):")
        for proj_id, project in self.projects.items():
            status = "VALID" if project.valid else "INVALID"
            print(f"\n  {proj_id}: {project.name}")
            print(f"    Path: {project.path}")
            print(f"    Rows: {len(project.rows)}")
            print(f"    Status: {status}")
            if project.errors:
                for err in project.errors[:3]:
                    print(f"      - {err}")
                all_valid = False

        # Overall stats
        stats = self.get_stats()
        print(f"\n{'=' * 70}")
        print("SUMMARY")
        print(f"{'=' * 70}")
        print(f"  Total managed rows: {stats['total_managed_rows']}")
        print(f"  Orchestrator nodes: {stats['orchestrator_nodes']}")
        print(f"  Project rows: {stats['project_rows_total']}")
        print(f"  Locked nodes: {stats['locked_nodes']}")
        print(f"\n  Scopes:")
        for scope, count in sorted(stats['by_scope'].items()):
            print(f"    {scope}: {count}")

        return all_valid

    def show_graph(self, target: Optional[str] = None) -> None:
        """Show dependency graph."""
        print(f"\n{'=' * 70}")
        print("DEPENDENCY GRAPH")
        print(f"{'=' * 70}")

        if target:
            node = self.nodes.get(target)
            if not node:
                print(f"Node not found: {target}")
                return

            print(f"\nTarget: {target}")
            print(f"  Name: {node.name}")
            print(f"  Scope: {node.scope or 'config'}")
            print(f"  Locked: {node.locked}")

            direct = self.graph.get(target, set())
            trans = self.get_transitive_deps(target)
            dependents = self.reverse_graph.get(target, set())

            if direct:
                print(f"\n  Direct dependencies ({len(direct)}):")
                for d in sorted(direct):
                    n = self.nodes.get(d)
                    scope = f" [{n.scope}]" if n and n.scope else ""
                    print(f"    - {d}{scope}")

            if trans - direct:
                print(f"\n  Transitive dependencies ({len(trans - direct)}):")
                for d in sorted(trans - direct)[:20]:
                    n = self.nodes.get(d)
                    scope = f" [{n.scope}]" if n and n.scope else ""
                    print(f"    - {d}{scope}")
                if len(trans - direct) > 20:
                    print(f"    ... and {len(trans - direct) - 20} more")

            if dependents:
                print(f"\n  Dependents ({len(dependents)}):")
                for d in sorted(dependents):
                    n = self.nodes.get(d)
                    scope = f" [{n.scope}]" if n and n.scope else ""
                    print(f"    - {d}{scope}")
        else:
            # Show by scope
            by_scope: Dict[str, List[str]] = defaultdict(list)
            for node_id, node in self.nodes.items():
                by_scope[node.scope or "config"].append(node_id)

            for scope in sorted(by_scope.keys()):
                nodes = by_scope[scope]
                print(f"\n{scope.upper()} ({len(nodes)}):")
                for node_id in sorted(nodes):
                    node = self.nodes[node_id]
                    deps = self.graph.get(node_id, set())
                    lock = " LOCKED" if node.locked else ""
                    if deps:
                        print(f"  {node_id}{lock}")
                        print(f"    <- {', '.join(sorted(deps)[:5])}" +
                              (f" (+{len(deps)-5})" if len(deps) > 5 else ""))
                    else:
                        print(f"  {node_id}{lock} [root]")

    def list_pipelines(self) -> None:
        """List available pipelines."""
        print(f"\n{'=' * 70}")
        print("AVAILABLE PIPELINES")
        print(f"{'=' * 70}\n")

        pipelines = [
            (node_id, node)
            for node_id, node in self.nodes.items()
            if node.scope == "pipeline"
        ]

        for node_id, node in sorted(pipelines, key=lambda x: x[0]):
            lock = " [LOCKED]" if node.locked else ""
            deps = self.get_transitive_deps(node_id)
            print(f"{node_id}: {node.name}{lock}")
            print(f"  Dependencies: {len(deps)} nodes")
            print(f"  Args: {node.args or '(none)'}")
            print()

    def run_project_command(self, project_id: str, command: str,
                           dry_run: bool = False) -> bool:
        """Run a command in a project directory."""
        project = self.projects.get(project_id)
        if not project:
            print(f"Project not found: {project_id}")
            return False

        print(f"\nRunning in {project.name}:")
        print(f"  Path: {project.path}")
        print(f"  Command: {command}")

        if dry_run:
            print("  [DRY RUN]")
            return True

        if not project.path.exists():
            print(f"  ERROR: Path does not exist")
            return False

        try:
            env = os.environ.copy()
            env["TOPDOWN_ROOT"] = str(project.path)

            result = subprocess.run(
                command,
                shell=True,
                cwd=project.path,
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )

            if result.stdout:
                print(result.stdout)
            if result.returncode != 0:
                print(f"  FAILED (exit code {result.returncode})")
                if result.stderr:
                    print(result.stderr)
                return False

            return True
        except subprocess.TimeoutExpired:
            print("  TIMEOUT")
            return False
        except Exception as e:
            print(f"  ERROR: {e}")
            return False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Workspace Orchestrator - Multi-project Top-Down management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  orchestrator.py --validate            Validate all configs
  orchestrator.py --list                List available pipelines
  orchestrator.py pipeline-ci           Run CI pipeline
  orchestrator.py pipeline-release -n   Dry run release pipeline
  orchestrator.py --graph wf-deploy-prod  Show deps for production deploy
  orchestrator.py --run-in project-buildsystem "python build.py --list"
        """
    )
    parser.add_argument(
        "pipeline",
        nargs="?",
        help="Pipeline to run"
    )
    parser.add_argument(
        "--validate", "-v",
        action="store_true",
        help="Validate all configs"
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List available pipelines"
    )
    parser.add_argument(
        "--graph", "-g",
        nargs="?",
        const="__all__",
        help="Show dependency graph"
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Dry run mode"
    )
    parser.add_argument(
        "--auto-approve", "-y",
        action="store_true",
        help="Auto-approve locked nodes"
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Verbose output"
    )
    parser.add_argument(
        "--run-in",
        nargs=2,
        metavar=("PROJECT", "COMMAND"),
        help="Run command in project directory"
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Show workspace statistics"
    )
    parser.add_argument(
        "--propagate",
        metavar="NODE",
        help="Test propagation from a node"
    )
    parser.add_argument(
        "--chain",
        metavar="NODE",
        help="Show propagation chain from a node"
    )

    args = parser.parse_args()

    orch = Orchestrator()

    if args.validate:
        valid = orch.validate_all()
        return 0 if valid else 1

    if args.list:
        orch.list_pipelines()
        return 0

    if args.graph:
        target = None if args.graph == "__all__" else args.graph
        orch.show_graph(target)
        return 0

    if args.stats:
        stats = orch.get_stats()
        print(json.dumps(stats, indent=2))
        return 0

    if args.propagate:
        success = orch.test_propagation(args.propagate)
        return 0 if success else 1

    if args.chain:
        orch.show_propagation_chain(args.chain)
        return 0

    if args.run_in:
        project_id, command = args.run_in
        success = orch.run_project_command(project_id, command, dry_run=args.dry_run)
        return 0 if success else 1

    if args.pipeline:
        success = orch.run_pipeline(
            args.pipeline,
            dry_run=args.dry_run,
            auto_approve=args.auto_approve,
            verbose=args.verbose,
        )
        return 0 if success else 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
