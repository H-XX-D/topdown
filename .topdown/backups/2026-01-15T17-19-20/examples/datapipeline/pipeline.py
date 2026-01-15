#!/usr/bin/env python3
"""
Data Pipeline Runner - Complex example using Top-Down for configuration.

Demonstrates:
- Complex dependency graphs
- Environment variants (dev/prod)
- Parallel execution planning
- Validation and error handling
- Metrics tracking
"""

import argparse
import random
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

# Add parent directories to find topdown_runtime
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))

from topdown_runtime import td, TopDownIdNotFound, TopDownRow
from topdown_cli import TopDownValidator


@dataclass
class StageResult:
    stage_id: str
    success: bool
    duration_ms: int
    records_processed: int = 0
    error: Optional[str] = None


@dataclass
class PipelineMetrics:
    total_stages: int = 0
    successful_stages: int = 0
    failed_stages: int = 0
    total_records: int = 0
    total_duration_ms: int = 0
    results: List[StageResult] = field(default_factory=list)

    def add_result(self, result: StageResult) -> None:
        self.results.append(result)
        self.total_stages += 1
        self.total_duration_ms += result.duration_ms
        if result.success:
            self.successful_stages += 1
            self.total_records += result.records_processed
        else:
            self.failed_stages += 1

    def summary(self) -> str:
        lines = [
            f"\n{'=' * 60}",
            "PIPELINE EXECUTION SUMMARY",
            f"{'=' * 60}",
            f"Stages: {self.successful_stages}/{self.total_stages} successful",
            f"Records processed: {self.total_records:,}",
            f"Total duration: {self.total_duration_ms / 1000:.2f}s",
            "",
            "Stage Results:",
        ]
        for r in self.results:
            status = "OK" if r.success else f"FAIL: {r.error}"
            lines.append(f"  {r.stage_id}: {status} ({r.duration_ms}ms, {r.records_processed:,} records)")
        return "\n".join(lines)


class DataPipeline:
    """Data pipeline using Top-Down configuration."""

    def __init__(self, env: str = "dev"):
        self.env = env
        self.stages: Dict[str, TopDownRow] = {}
        self.graph: Dict[str, List[str]] = defaultdict(list)  # stage -> dependencies
        self.reverse_graph: Dict[str, List[str]] = defaultdict(list)  # stage -> dependents
        self.metrics = PipelineMetrics()
        self._load_stages()

    def _load_stages(self) -> None:
        """Load all stages from config."""
        # Define which stages to load based on environment
        stage_ids = [
            "db-connection" if self.env == "dev" else "db-connection-prod",
            "api-credentials",
            "extract-users",
            "extract-orders",
            "extract-products",
            "transform-normalize",
            "transform-enrich",
            "transform-aggregate",
            "validate-schema",
            "load-warehouse" if self.env == "dev" else "load-warehouse-prod",
            "notify-slack",
            "cleanup-temp",
        ]

        for stage_id in stage_ids:
            try:
                config = td(stage_id)
                self.stages[stage_id] = config

                # Build dependency graph
                for dep in config.depends:
                    # Map dev/prod variants
                    actual_dep = dep
                    if dep == "db-connection" and self.env == "prod":
                        actual_dep = "db-connection-prod"
                    elif dep == "load-warehouse" and self.env == "prod":
                        actual_dep = "load-warehouse-prod"

                    if actual_dep in stage_ids or dep in stage_ids:
                        self.graph[stage_id].append(dep if dep in stage_ids else actual_dep)
                        self.reverse_graph[dep if dep in stage_ids else actual_dep].append(stage_id)
            except TopDownIdNotFound:
                print(f"Warning: Stage {stage_id} not found")

    def detect_cycles(self) -> List[List[str]]:
        """Detect cycles in the dependency graph."""
        cycles = []
        visited = set()
        rec_stack = set()

        def dfs(node: str, path: List[str]) -> None:
            visited.add(node)
            rec_stack.add(node)
            path.append(node)

            for dep in self.graph.get(node, []):
                if dep not in visited:
                    dfs(dep, path)
                elif dep in rec_stack:
                    cycle_start = path.index(dep)
                    cycles.append(path[cycle_start:] + [dep])

            path.pop()
            rec_stack.remove(node)

        for node in self.stages:
            if node not in visited:
                dfs(node, [])

        return cycles

    def get_execution_levels(self) -> List[List[str]]:
        """Get stages grouped by execution level (for parallel execution)."""
        in_degree = {s: 0 for s in self.stages}
        for stage, deps in self.graph.items():
            for dep in deps:
                if dep in in_degree:
                    in_degree[stage] += 1

        levels = []
        remaining = set(self.stages.keys())

        while remaining:
            # Find all stages with no remaining dependencies
            level = [s for s in remaining if in_degree[s] == 0]
            if not level:
                # Cycle detected
                break

            levels.append(sorted(level))

            # Remove this level and update in-degrees
            for s in level:
                remaining.remove(s)
                for dependent in self.reverse_graph[s]:
                    if dependent in remaining:
                        in_degree[dependent] -= 1

        return levels

    def get_downstream(self, stage_id: str) -> Set[str]:
        """Get all stages that depend on the given stage (directly or indirectly)."""
        downstream = set()
        queue = [stage_id]

        while queue:
            current = queue.pop(0)
            for dependent in self.reverse_graph[current]:
                if dependent not in downstream:
                    downstream.add(dependent)
                    queue.append(dependent)

        return downstream

    def simulate_stage(self, stage_id: str, dry_run: bool = False) -> StageResult:
        """Simulate executing a stage."""
        stage = self.stages[stage_id]

        print(f"\n  [{stage_id}] {stage.name}")
        print(f"    Args: {stage.args if stage.args else '(none)'}")
        if stage.depends:
            print(f"    Depends: {', '.join(stage.depends)}")

        if stage.locked:
            print(f"    ⚠️  LOCKED STAGE - requires confirmation in production")
            if not dry_run:
                confirm = input("    Type 'yes' to proceed: ")
                if confirm.lower() != 'yes':
                    return StageResult(
                        stage_id=stage_id,
                        success=False,
                        duration_ms=0,
                        error="Not confirmed"
                    )

        if dry_run:
            print(f"    [DRY RUN] Would execute")
            return StageResult(
                stage_id=stage_id,
                success=True,
                duration_ms=0,
                records_processed=0
            )

        # Simulate processing
        duration = random.randint(100, 500)
        records = random.randint(1000, 50000) if "extract" in stage_id or "transform" in stage_id else 0

        print(f"    Processing", end="", flush=True)
        for _ in range(3):
            time.sleep(duration / 3000)
            print(".", end="", flush=True)

        # Simulate occasional failures (5% chance)
        if random.random() < 0.05 and not stage.locked:
            print(f" FAILED!")
            return StageResult(
                stage_id=stage_id,
                success=False,
                duration_ms=duration,
                error="Simulated failure"
            )

        print(f" OK ({records:,} records)")
        return StageResult(
            stage_id=stage_id,
            success=True,
            duration_ms=duration,
            records_processed=records
        )

    def run(self, target: Optional[str] = None, dry_run: bool = False) -> bool:
        """Run the pipeline."""
        print(f"\n{'=' * 60}")
        print(f"DATA PIPELINE - Environment: {self.env.upper()}")
        print(f"{'=' * 60}")

        # Validate first
        cycles = self.detect_cycles()
        if cycles:
            print("\n❌ ERROR: Circular dependencies detected!")
            for cycle in cycles:
                print(f"   {' -> '.join(cycle)}")
            return False

        # Get execution plan
        levels = self.get_execution_levels()

        print(f"\nExecution Plan ({len(self.stages)} stages, {len(levels)} levels):")
        for i, level in enumerate(levels):
            parallel_note = " (can run in parallel)" if len(level) > 1 else ""
            print(f"  Level {i + 1}: {', '.join(level)}{parallel_note}")

        if target:
            print(f"\nTarget stage: {target}")
            downstream = self.get_downstream(target)
            if downstream:
                print(f"Would affect: {', '.join(sorted(downstream))}")

        print(f"\n{'=' * 60}")
        print("EXECUTION")
        print(f"{'=' * 60}")

        # Execute level by level
        for i, level in enumerate(levels):
            print(f"\n--- Level {i + 1} ---")

            for stage_id in level:
                if target and stage_id != target:
                    # Skip stages not in target's path
                    continue

                result = self.simulate_stage(stage_id, dry_run=dry_run)
                self.metrics.add_result(result)

                if not result.success:
                    print(f"\n❌ Pipeline failed at stage: {stage_id}")
                    print(f"   Error: {result.error}")
                    print(f"\n   Downstream stages that would be affected:")
                    for ds in sorted(self.get_downstream(stage_id)):
                        print(f"     - {ds}")
                    return False

        print(self.metrics.summary())
        return True

    def show_dag(self) -> None:
        """Display the DAG structure."""
        print(f"\n{'=' * 60}")
        print("DEPENDENCY GRAPH (DAG)")
        print(f"{'=' * 60}\n")

        levels = self.get_execution_levels()

        for i, level in enumerate(levels):
            print(f"Level {i + 1}:")
            for stage_id in level:
                stage = self.stages[stage_id]
                deps = self.graph.get(stage_id, [])
                lock = " 🔒" if stage.locked else ""

                if deps:
                    print(f"  {stage_id}{lock}")
                    for dep in deps:
                        print(f"    └── depends on: {dep}")
                else:
                    print(f"  {stage_id}{lock} (root)")
            print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Data Pipeline Runner - powered by Top-Down"
    )
    parser.add_argument(
        "--env", "-e",
        choices=["dev", "prod"],
        default="dev",
        help="Environment (dev or prod)"
    )
    parser.add_argument(
        "--target", "-t",
        help="Run only up to this stage"
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Show what would be done"
    )
    parser.add_argument(
        "--dag",
        action="store_true",
        help="Show dependency graph and exit"
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate config and exit"
    )

    args = parser.parse_args()

    # Validate config
    if args.validate:
        config_path = Path(".topdown/config.json")
        validator = TopDownValidator(config_path)
        if not validator.load():
            print("Failed to load config")
            return 2
        validator.run_all_validations()
        errors = validator.get_errors()
        warnings = validator.get_warnings()

        if errors:
            print("Errors:")
            for e in errors:
                print(f"  ❌ {e.message}")
        if warnings:
            print("Warnings:")
            for w in warnings:
                print(f"  ⚠️  {w.message}")

        if not errors:
            print("✅ Config is valid")
            return 0
        return 1

    pipeline = DataPipeline(env=args.env)

    if args.dag:
        pipeline.show_dag()
        return 0

    success = pipeline.run(target=args.target, dry_run=args.dry_run)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
