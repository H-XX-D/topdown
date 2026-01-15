#!/usr/bin/env python3
"""
Task Runner - A simple task runner using Top-Down for configuration.

This demonstrates how Top-Down can manage task dependencies and parameters
in a real application.
"""

import argparse
import shlex
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

# Add parent directories to find topdown_runtime
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))

from topdown_runtime import td, TopDownIdNotFound


@dataclass
class Task:
    id: str
    name: str
    args: List[str]
    timeout: int
    retries: int
    depends: List[str]
    locked: bool

    def run(self, dry_run: bool = False) -> bool:
        """Execute the task."""
        print(f"\n{'=' * 50}")
        print(f"Task: {self.name} ({self.id})")
        print(f"Args: {' '.join(self.args) if self.args else '(none)'}")
        print(f"Timeout: {self.timeout}s | Retries: {self.retries}")
        if self.locked:
            print("Status: LOCKED (requires confirmation)")
        print(f"{'=' * 50}")

        if dry_run:
            print("[DRY RUN] Would execute task")
            return True

        if self.locked:
            confirm = input("This task is locked. Type 'yes' to confirm: ")
            if confirm.lower() != 'yes':
                print("Skipped (not confirmed)")
                return False

        # Simulate task execution
        print("Running", end="", flush=True)
        for _ in range(3):
            time.sleep(0.3)
            print(".", end="", flush=True)
        print(" Done!")
        return True


class TaskRunner:
    """Task runner that uses Top-Down configuration."""

    def __init__(self):
        self.tasks: Dict[str, Task] = {}
        self._load_tasks()

    def _load_tasks(self) -> None:
        """Load tasks from Top-Down config."""
        # @td:task-timeout
        timeout_config = td("task-timeout")
        default_timeout = int(timeout_config.expr) if timeout_config.expr else 30

        # @td:max-retries
        retry_config = td("max-retries")
        default_retries = int(retry_config.expr) if retry_config.expr else 3

        # @td:parallel-workers
        workers_config = td("parallel-workers")
        self.max_workers = int(workers_config.expr) if workers_config.expr else 4

        # Load actual tasks
        for task_id in ["build-task", "test-task", "deploy-task"]:
            try:
                # @td:build-task
                # @td:test-task
                # @td:deploy-task
                config = td(task_id)
                self.tasks[task_id] = Task(
                    id=task_id,
                    name=config.name,
                    args=config.args_list(),
                    timeout=default_timeout,
                    retries=default_retries,
                    depends=config.depends or [],
                    locked=config.locked,
                )
            except TopDownIdNotFound:
                print(f"Warning: Task {task_id} not found in config")

    def get_execution_order(self, task_id: str) -> List[str]:
        """Get tasks in dependency order (topological sort)."""
        visited = set()
        order = []

        def visit(tid: str) -> None:
            if tid in visited:
                return
            visited.add(tid)
            task = self.tasks.get(tid)
            if task:
                for dep in task.depends:
                    if dep in self.tasks:
                        visit(dep)
                order.append(tid)

        visit(task_id)
        return order

    def run(self, task_id: str, dry_run: bool = False) -> bool:
        """Run a task and its dependencies."""
        if task_id not in self.tasks:
            print(f"Error: Unknown task '{task_id}'")
            print(f"Available tasks: {', '.join(self.tasks.keys())}")
            return False

        execution_order = self.get_execution_order(task_id)
        print(f"\nExecution plan: {' -> '.join(execution_order)}")
        print(f"Max workers: {self.max_workers}")

        for tid in execution_order:
            task = self.tasks[tid]
            success = task.run(dry_run=dry_run)
            if not success:
                print(f"\nTask {tid} failed. Stopping.")
                return False

        print(f"\nAll tasks completed successfully!")
        return True

    def list_tasks(self) -> None:
        """List all available tasks."""
        print("\nAvailable tasks:")
        print("-" * 60)
        for task in self.tasks.values():
            deps = f" (depends: {', '.join(task.depends)})" if task.depends else ""
            lock = " [LOCKED]" if task.locked else ""
            print(f"  {task.id}: {task.name}{deps}{lock}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Task Runner - powered by Top-Down config"
    )
    parser.add_argument(
        "task",
        nargs="?",
        help="Task to run (e.g., build-task, test-task, deploy-task)"
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List available tasks"
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Show what would be done without executing"
    )

    args = parser.parse_args()
    runner = TaskRunner()

    if args.list or not args.task:
        runner.list_tasks()
        return 0

    success = runner.run(args.task, dry_run=args.dry_run)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
