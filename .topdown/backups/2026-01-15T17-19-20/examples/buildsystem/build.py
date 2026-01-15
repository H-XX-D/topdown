#!/usr/bin/env python3
"""
Build System - Extreme test of Top-Down for configuration.

Features:
- 40 configuration rows across 7 scopes
- Transitive dependency resolution
- Incremental builds with file hashing
- Parallel execution planning
- Build profiles (dev, ci, release)
- Multiple artifact types (lib, bin, test, package, deploy)
- Build cache simulation
- Cycle detection and validation
"""

import argparse
import hashlib
import json
import random
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# Add parent directories to find topdown_runtime
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))

from topdown_runtime import td, TopDownIdNotFound, TopDownRow
from topdown_cli import TopDownValidator


@dataclass
class BuildArtifact:
    """Represents a build artifact."""
    target_id: str
    output: str
    hash: str
    build_time_ms: int
    cached: bool = False


@dataclass
class BuildStats:
    """Build statistics."""
    total_targets: int = 0
    built: int = 0
    cached: int = 0
    failed: int = 0
    skipped: int = 0
    total_time_ms: int = 0
    artifacts: List[BuildArtifact] = field(default_factory=list)

    def add(self, artifact: BuildArtifact) -> None:
        self.artifacts.append(artifact)
        self.total_targets += 1
        self.total_time_ms += artifact.build_time_ms
        if artifact.cached:
            self.cached += 1
        else:
            self.built += 1

    def fail(self, target_id: str) -> None:
        self.total_targets += 1
        self.failed += 1

    def skip(self) -> None:
        self.total_targets += 1
        self.skipped += 1


class BuildCache:
    """Simulated build cache."""

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        self.cache_file = cache_dir / "cache.json"
        self.entries: Dict[str, Dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if self.cache_file.exists():
            try:
                self.entries = json.loads(self.cache_file.read_text())
            except Exception:
                self.entries = {}

    def save(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_file.write_text(json.dumps(self.entries, indent=2))

    def get(self, target_id: str, input_hash: str) -> Optional[str]:
        entry = self.entries.get(target_id)
        if entry and entry.get("input_hash") == input_hash:
            return entry.get("output_hash")
        return None

    def put(self, target_id: str, input_hash: str, output_hash: str) -> None:
        self.entries[target_id] = {
            "input_hash": input_hash,
            "output_hash": output_hash,
            "timestamp": time.time(),
        }

    def invalidate(self, target_id: str) -> None:
        self.entries.pop(target_id, None)

    def clear(self) -> None:
        self.entries.clear()


class BuildSystem:
    """Build system using Top-Down configuration."""

    SCOPES = ["library", "binary", "test", "package", "deploy", "profile", None]

    def __init__(self, profile: str = "dev"):
        self.profile_name = profile
        self.targets: Dict[str, TopDownRow] = {}
        self.graph: Dict[str, Set[str]] = defaultdict(set)
        self.reverse_graph: Dict[str, Set[str]] = defaultdict(set)
        self.profile_deps: Set[str] = set()
        self.stats = BuildStats()
        self.cache = BuildCache(Path(".build_cache"))
        self._load_config()

    def _load_config(self) -> None:
        """Load all targets from config."""
        # First load the profile to get inherited settings
        profile_id = f"profile-{self.profile_name}"
        try:
            profile = td(profile_id)
            self.targets[profile_id] = profile
            self._collect_profile_deps(profile)
        except TopDownIdNotFound:
            print(f"Warning: Profile '{profile_id}' not found, using defaults")

        # Load all targets
        config_path = Path(".topdown/config.json")
        if not config_path.exists():
            raise RuntimeError("Config not found")

        data = json.loads(config_path.read_text())
        for row in data.get("rows", []):
            row_id = row.get("id", "")
            if not row_id:
                continue
            try:
                target = td(row_id)
                self.targets[row_id] = target

                # Build dependency graph
                for dep in target.depends:
                    self.graph[row_id].add(dep)
                    self.reverse_graph[dep].add(row_id)
            except TopDownIdNotFound:
                pass

    def _collect_profile_deps(self, profile: TopDownRow) -> None:
        """Recursively collect all profile dependencies."""
        for dep in profile.depends:
            self.profile_deps.add(dep)
            try:
                dep_row = td(dep)
                self._collect_profile_deps(dep_row)
            except TopDownIdNotFound:
                pass

    def get_compiler_flags(self) -> List[str]:
        """Get combined compiler flags from profile."""
        flags = []
        for dep_id in self.profile_deps:
            target = self.targets.get(dep_id)
            if target and target.args:
                flags.extend(target.args.split())
        return flags

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

        for node in self.targets:
            if node not in visited:
                dfs(node, [])

        return cycles

    def get_transitive_deps(self, target_id: str) -> Set[str]:
        """Get all transitive dependencies."""
        deps = set()
        queue = list(self.graph.get(target_id, set()))

        while queue:
            dep = queue.pop(0)
            if dep not in deps:
                deps.add(dep)
                queue.extend(self.graph.get(dep, set()))

        return deps

    def get_build_order(self, targets: List[str]) -> List[List[str]]:
        """Get targets in build order (topological sort by levels)."""
        # Collect all targets and their transitive deps
        all_targets = set(targets)
        for t in targets:
            all_targets.update(self.get_transitive_deps(t))

        # Filter to only buildable targets (have scope)
        buildable = {t for t in all_targets
                    if t in self.targets and self.targets[t].scope in self.SCOPES}

        # Compute in-degrees
        in_degree = {t: 0 for t in buildable}
        for t in buildable:
            for dep in self.graph.get(t, set()):
                if dep in buildable:
                    in_degree[t] += 1

        # Kahn's algorithm by levels
        levels = []
        remaining = set(buildable)

        while remaining:
            level = [t for t in remaining if in_degree[t] == 0]
            if not level:
                break  # Cycle

            levels.append(sorted(level))

            for t in level:
                remaining.remove(t)
                for dependent in self.reverse_graph.get(t, set()):
                    if dependent in remaining:
                        in_degree[dependent] -= 1

        return levels

    def compute_hash(self, target_id: str, dep_hashes: Optional[Dict[str, str]] = None) -> str:
        """Compute a hash for a target based on its inputs.

        Includes transitive dependency hashes for proper propagation.
        """
        target = self.targets.get(target_id)
        if not target:
            return ""

        if dep_hashes is None:
            dep_hashes = {}

        # Get hashes of direct dependencies (recursively computed)
        dep_hash_parts = []
        for dep in sorted(target.depends):
            if dep in dep_hashes:
                dep_hash_parts.append(f"{dep}:{dep_hashes[dep]}")
            elif dep in self.targets:
                # Recursively compute dependency hash
                dep_hash = self.compute_hash(dep, dep_hashes)
                dep_hashes[dep] = dep_hash
                dep_hash_parts.append(f"{dep}:{dep_hash}")

        # Hash includes: args, expr, dep hashes, profile flags
        parts = [
            target.args or "",
            target.expr or "",
            "|".join(dep_hash_parts),
            "|".join(sorted(self.get_compiler_flags())),
        ]
        return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]

    def get_affected_targets(self, changed_id: str) -> Set[str]:
        """Get all targets affected by a change to the given target.

        Returns targets that would need rebuilding if changed_id is modified.
        """
        affected = set()
        queue = [changed_id]

        while queue:
            current = queue.pop(0)
            for dependent in self.reverse_graph.get(current, set()):
                if dependent not in affected:
                    affected.add(dependent)
                    queue.append(dependent)

        return affected

    def test_propagation(self, target_id: str) -> None:
        """Test that changes to a target properly propagate to dependents."""
        if target_id not in self.targets:
            print(f"ERROR: Target '{target_id}' not found")
            return

        target = self.targets[target_id]
        affected = self.get_affected_targets(target_id)

        print(f"\n{'=' * 70}")
        print(f"PROPAGATION TEST: {target_id}")
        print(f"{'=' * 70}")

        print(f"\nTarget: {target_id}")
        print(f"  Name: {target.name}")
        print(f"  Current args: {target.args or '(none)'}")
        print(f"  Current hash: {self.compute_hash(target_id)}")

        # Compute current hashes for all affected
        print(f"\nAffected targets ({len(affected)}):")
        current_hashes: Dict[str, str] = {}
        for t in sorted(affected):
            h = self.compute_hash(t)
            current_hashes[t] = h
            node = self.targets.get(t)
            scope = f"[{node.scope}]" if node and node.scope else ""
            print(f"  {t} {scope}: {h}")

        # Simulate a change by temporarily modifying the target
        print(f"\n{'=' * 70}")
        print("SIMULATING CHANGE")
        print(f"{'=' * 70}")

        # Create a modified version of the target
        original_target = self.targets[target_id]
        modified_args = (original_target.args or "") + " --modified"

        # Temporarily replace with modified target
        from topdown_runtime import TopDownRow
        modified_target = TopDownRow(
            id=original_target.id,
            locked=original_target.locked,
            name=original_target.name,
            args=modified_args,
            expr=original_target.expr,
            scope=original_target.scope,
            depends=original_target.depends,
        )
        self.targets[target_id] = modified_target

        new_hash = self.compute_hash(target_id)
        print(f"\nModified {target_id}:")
        print(f"  New args: {modified_args}")
        print(f"  New hash: {new_hash}")
        print(f"  Hash changed: {new_hash != current_hashes.get(target_id, '')}")

        # Check propagation to dependents
        print(f"\nPropagation results:")
        propagated_count = 0
        for t in sorted(affected):
            old_hash = current_hashes[t]
            new_hash = self.compute_hash(t)
            changed = old_hash != new_hash
            if changed:
                propagated_count += 1
            status = "PROPAGATED" if changed else "UNCHANGED"
            print(f"  {t}: {old_hash[:8]}... -> {new_hash[:8]}... [{status}]")

        # Restore original
        self.targets[target_id] = original_target

        # Summary
        print(f"\n{'=' * 70}")
        print("PROPAGATION SUMMARY")
        print(f"{'=' * 70}")
        print(f"  Changed target: {target_id}")
        print(f"  Direct dependents: {len(self.reverse_graph.get(target_id, set()))}")
        print(f"  Total affected: {len(affected)}")
        print(f"  Successfully propagated: {propagated_count}")
        print(f"  Propagation working: {'YES' if propagated_count == len(affected) else 'NO'}")

        if propagated_count == len(affected):
            print(f"\n  All {len(affected)} dependent targets would be rebuilt!")
        else:
            print(f"\n  WARNING: {len(affected) - propagated_count} targets not propagated!")

    def show_propagation_chain(self, target_id: str) -> None:
        """Show the full propagation chain from a target."""
        if target_id not in self.targets:
            print(f"ERROR: Target '{target_id}' not found")
            return

        print(f"\n{'=' * 70}")
        print(f"PROPAGATION CHAIN: {target_id}")
        print(f"{'=' * 70}")

        # BFS to find levels of propagation
        levels: List[Set[str]] = []
        visited = {target_id}
        current_level = {target_id}

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

        print(f"\nSource: {target_id}")
        target = self.targets[target_id]
        print(f"  {target.name}")

        for i, level in enumerate(levels):
            print(f"\nLevel {i + 1} (propagates to {len(level)} targets):")
            for t in sorted(level):
                node = self.targets.get(t)
                if node:
                    scope = f"[{node.scope}]" if node.scope else ""
                    lock = " LOCKED" if node.locked else ""
                    print(f"  -> {t} {scope}{lock}")

        total = sum(len(l) for l in levels)
        print(f"\nTotal propagation reach: {total} targets across {len(levels)} levels")

    def build_target(self, target_id: str, dry_run: bool = False,
                    force: bool = False) -> Optional[BuildArtifact]:
        """Build a single target."""
        target = self.targets.get(target_id)
        if not target:
            return None

        scope = target.scope or "config"
        output = target.expr or target_id
        input_hash = self.compute_hash(target_id)

        # Check cache
        if not force:
            cached_hash = self.cache.get(target_id, input_hash)
            if cached_hash:
                return BuildArtifact(
                    target_id=target_id,
                    output=output,
                    hash=cached_hash,
                    build_time_ms=0,
                    cached=True,
                )

        if dry_run:
            return BuildArtifact(
                target_id=target_id,
                output=output,
                hash=input_hash,
                build_time_ms=0,
                cached=False,
            )

        # Simulate build
        base_time = {
            "library": 200,
            "binary": 150,
            "test": 100,
            "package": 300,
            "deploy": 500,
        }.get(scope, 50)

        build_time = random.randint(base_time, base_time * 2)

        # Simulate occasional failures (2% chance)
        if random.random() < 0.02 and not target.locked:
            return None

        output_hash = hashlib.sha256(f"{target_id}:{time.time()}".encode()).hexdigest()[:16]
        self.cache.put(target_id, input_hash, output_hash)

        return BuildArtifact(
            target_id=target_id,
            output=output,
            hash=output_hash,
            build_time_ms=build_time,
            cached=False,
        )

    def build(self, targets: List[str], dry_run: bool = False,
              force: bool = False, verbose: bool = False) -> bool:
        """Build specified targets and their dependencies."""
        # Validate first
        cycles = self.detect_cycles()
        if cycles:
            print("\nERROR: Circular dependencies detected!")
            for cycle in cycles[:3]:  # Show first 3
                print(f"  {' -> '.join(cycle)}")
            return False

        build_order = self.get_build_order(targets)
        if not build_order:
            print("No targets to build")
            return True

        # Header
        print(f"\n{'=' * 70}")
        print(f"BUILD SYSTEM - Profile: {self.profile_name.upper()}")
        print(f"{'=' * 70}")

        # Show compiler flags
        flags = self.get_compiler_flags()
        if verbose and flags:
            print(f"\nCompiler flags: {' '.join(flags)}")

        # Show build plan
        total = sum(len(level) for level in build_order)
        print(f"\nBuild plan: {total} targets in {len(build_order)} levels")

        for i, level in enumerate(build_order):
            parallel = " [parallel]" if len(level) > 1 else ""
            targets_str = ", ".join(level[:5])
            if len(level) > 5:
                targets_str += f", ... (+{len(level) - 5} more)"
            print(f"  L{i+1}: {targets_str}{parallel}")

        print(f"\n{'=' * 70}")
        print("BUILDING")
        print(f"{'=' * 70}")

        # Build level by level
        failed_targets: Set[str] = set()

        for level_idx, level in enumerate(build_order):
            level_name = f"Level {level_idx + 1}/{len(build_order)}"

            for target_id in level:
                target = self.targets.get(target_id)
                if not target:
                    continue

                # Skip if any dependency failed
                deps = self.graph.get(target_id, set())
                if deps & failed_targets:
                    print(f"  SKIP {target_id} (dependency failed)")
                    self.stats.skip()
                    continue

                # Build
                scope = target.scope or "config"
                lock = " [LOCKED]" if target.locked else ""
                print(f"\n  [{scope.upper()}] {target.name}{lock}")
                print(f"    Target: {target_id}")

                if target.locked and not dry_run:
                    confirm = input("    This target is LOCKED. Type 'yes' to proceed: ")
                    if confirm.lower() != 'yes':
                        print("    Skipped (not confirmed)")
                        self.stats.skip()
                        continue

                if verbose:
                    print(f"    Args: {target.args or '(none)'}")
                    if target.depends:
                        print(f"    Deps: {', '.join(target.depends)}")

                artifact = self.build_target(target_id, dry_run=dry_run, force=force)

                if artifact is None:
                    print(f"    FAILED!")
                    failed_targets.add(target_id)
                    self.stats.fail(target_id)
                    # Don't stop - continue with other targets
                    continue

                self.stats.add(artifact)

                if artifact.cached:
                    print(f"    CACHED [{artifact.hash}]")
                elif dry_run:
                    print(f"    [DRY RUN] Would build -> {artifact.output}")
                else:
                    print(f"    OK ({artifact.build_time_ms}ms) -> {artifact.output} [{artifact.hash}]")

        # Save cache
        if not dry_run:
            self.cache.save()

        # Summary
        self._print_summary(failed_targets)

        return len(failed_targets) == 0

    def _print_summary(self, failed: Set[str]) -> None:
        """Print build summary."""
        s = self.stats
        print(f"\n{'=' * 70}")
        print("BUILD SUMMARY")
        print(f"{'=' * 70}")
        print(f"  Total:   {s.total_targets}")
        print(f"  Built:   {s.built}")
        print(f"  Cached:  {s.cached} ({100*s.cached/max(1,s.total_targets):.0f}%)")
        print(f"  Skipped: {s.skipped}")
        print(f"  Failed:  {s.failed}")
        print(f"  Time:    {s.total_time_ms/1000:.2f}s")

        if failed:
            print(f"\nFailed targets:")
            for t in sorted(failed):
                print(f"  - {t}")

        # Cache efficiency
        hit_rate = s.cached / max(1, s.cached + s.built)
        print(f"\nCache hit rate: {100*hit_rate:.1f}%")

    def show_targets(self, scope: Optional[str] = None) -> None:
        """List all targets."""
        print(f"\n{'=' * 70}")
        print(f"TARGETS{f' (scope: {scope})' if scope else ''}")
        print(f"{'=' * 70}\n")

        by_scope: Dict[str, List[TopDownRow]] = defaultdict(list)
        for target in self.targets.values():
            s = target.scope or "config"
            if scope is None or s == scope:
                by_scope[s].append(target)

        for s in ["config", "library", "binary", "test", "package", "deploy", "profile"]:
            targets = by_scope.get(s, [])
            if not targets:
                continue

            print(f"{s.upper()} ({len(targets)}):")
            for t in sorted(targets, key=lambda x: x.id):
                lock = " [LOCKED]" if t.locked else ""
                deps = f" <- {', '.join(t.depends)}" if t.depends else ""
                print(f"  {t.id}: {t.name}{lock}{deps}")
            print()

    def show_graph(self, target_id: Optional[str] = None) -> None:
        """Show dependency graph."""
        print(f"\n{'=' * 70}")
        print("DEPENDENCY GRAPH")
        print(f"{'=' * 70}\n")

        if target_id:
            # Show graph for specific target
            target = self.targets.get(target_id)
            if not target:
                print(f"Unknown target: {target_id}")
                return

            print(f"Target: {target_id}")
            print(f"  Name: {target.name}")
            print(f"  Scope: {target.scope or 'config'}")

            direct_deps = self.graph.get(target_id, set())
            trans_deps = self.get_transitive_deps(target_id)
            dependents = self.reverse_graph.get(target_id, set())

            if direct_deps:
                print(f"\n  Direct dependencies ({len(direct_deps)}):")
                for d in sorted(direct_deps):
                    print(f"    - {d}")

            if trans_deps - direct_deps:
                print(f"\n  Transitive dependencies ({len(trans_deps - direct_deps)}):")
                for d in sorted(trans_deps - direct_deps):
                    print(f"    - {d}")

            if dependents:
                print(f"\n  Dependents ({len(dependents)}):")
                for d in sorted(dependents):
                    print(f"    - {d}")
        else:
            # Show full graph by levels
            all_targets = [t for t in self.targets if self.targets[t].scope]
            levels = self.get_build_order(all_targets)

            for i, level in enumerate(levels):
                parallel = " [can build in parallel]" if len(level) > 1 else ""
                print(f"Level {i + 1}:{parallel}")
                for target_id in level:
                    target = self.targets[target_id]
                    lock = " LOCKED" if target.locked else ""
                    deps = self.graph.get(target_id, set())
                    if deps:
                        print(f"  {target_id} ({target.scope}){lock}")
                        for d in sorted(deps):
                            print(f"    <- {d}")
                    else:
                        print(f"  {target_id} ({target.scope}){lock} [root]")
                print()

    def clean(self) -> None:
        """Clean build cache."""
        self.cache.clear()
        self.cache.save()
        print("Build cache cleared")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build System - powered by Top-Down",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  build.py bin-server              Build server binary
  build.py --all                   Build all targets
  build.py --profile release       Use release profile
  build.py --list                  List all targets
  build.py --graph bin-server      Show dependency graph
  build.py --clean                 Clear build cache
        """
    )
    parser.add_argument(
        "targets",
        nargs="*",
        help="Targets to build"
    )
    parser.add_argument(
        "--profile", "-p",
        choices=["dev", "ci", "release"],
        default="dev",
        help="Build profile (default: dev)"
    )
    parser.add_argument(
        "--all", "-a",
        action="store_true",
        help="Build all targets"
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Show what would be built"
    )
    parser.add_argument(
        "--force", "-f",
        action="store_true",
        help="Force rebuild (ignore cache)"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose output"
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List all targets"
    )
    parser.add_argument(
        "--scope", "-s",
        choices=["library", "binary", "test", "package", "deploy", "profile", "config"],
        help="Filter by scope (with --list)"
    )
    parser.add_argument(
        "--graph", "-g",
        nargs="?",
        const="__all__",
        help="Show dependency graph (optionally for specific target)"
    )
    parser.add_argument(
        "--clean", "-c",
        action="store_true",
        help="Clean build cache"
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate config and exit"
    )
    parser.add_argument(
        "--propagate",
        metavar="TARGET",
        help="Test propagation from a target"
    )
    parser.add_argument(
        "--chain",
        metavar="TARGET",
        help="Show propagation chain from a target"
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

        print(f"\nValidation Results:")
        print(f"  Rows: {len(validator.rows)}")

        if errors:
            print(f"\nErrors ({len(errors)}):")
            for e in errors:
                print(f"  - {e.message}")
        if warnings:
            print(f"\nWarnings ({len(warnings)}):")
            for w in warnings:
                print(f"  - {w.message}")

        if not errors:
            print("\nConfig is valid!")
            return 0
        return 1

    # Initialize build system
    build = BuildSystem(profile=args.profile)

    if args.clean:
        build.clean()
        return 0

    if args.list:
        build.show_targets(scope=args.scope)
        return 0

    if args.graph:
        target = None if args.graph == "__all__" else args.graph
        build.show_graph(target)
        return 0

    if args.propagate:
        build.test_propagation(args.propagate)
        return 0

    if args.chain:
        build.show_propagation_chain(args.chain)
        return 0

    # Determine targets to build
    targets = args.targets
    if args.all:
        targets = [t for t, row in build.targets.items() if row.scope in ["binary", "test"]]
    elif not targets:
        parser.print_help()
        return 0

    # Build
    success = build.build(
        targets=targets,
        dry_run=args.dry_run,
        force=args.force,
        verbose=args.verbose,
    )

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
