"""Simple wrapper for optional Weights & Biases integration.
Provides a fallback stub that records runs locally when `wandb` is not available
or when WANDB_MODE=offline is set.
"""
from pathlib import Path
import os
import json
import time
import uuid


class WandbStub:
    def __init__(self, project=None, name=None, config=None, run_dir="wandb_runs"):
        self.project = project
        self.name = name or f"run-{uuid.uuid4().hex[:6]}"
        self.config = config or {}
        # ensure run_dir is anchored at repo root for predictable test behavior
        repo_root = Path(__file__).resolve().parents[2]
        self.run_dir = repo_root / (run_dir if isinstance(run_dir, str) else str(run_dir))
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.file = self.run_dir / f"{self.name}.jsonl"
        # write initial metadata
        with open(self.file, "a", encoding="utf-8") as f:
            f.write(json.dumps({"_meta": {"project": project, "name": self.name, "config": self.config}}) + "\n")
        print(f"WandbStub initialized, writing to {self.file}")

    def log(self, metrics: dict, step: int = None):
        rec = {"step": step, "metrics": metrics, "ts": int(time.time())}
        with open(self.file, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")

    def save(self, path: str):
        # copy or record path in a manifest
        m = self.run_dir / f"{self.name}.artifacts.json"
        with open(m, "a", encoding="utf-8") as f:
            f.write(json.dumps({"saved": path}) + "\n")

    def finish(self):
        with open(self.file, "a", encoding="utf-8") as f:
            f.write(json.dumps({"_finished": int(time.time())}) + "\n")


def init_wandb(project: str = "parametrix", name: str = None, config: dict = None, offline: bool = False):
    """Initialize W&B if available, otherwise return a stub. If `offline=True`, prefer stub."""
    if offline:
        return WandbStub(project=project, name=name, config=config)
    try:
        import wandb
    except Exception:
        return WandbStub(project=project, name=name, config=config)

    run = wandb.init(project=project, name=name, config=config)
    return run


def log_metrics(run, metrics: dict, step: int = None):
    try:
        run.log(metrics, step=step)
    except Exception:
        # stub
        if hasattr(run, "log"):
            run.log(metrics, step=step)


def save_artifact(run, path: str):
    try:
        if hasattr(run, "save"):
            run.save(path)
    except Exception:
        try:
            run.save(path)
        except Exception:
            pass


def finish_run(run):
    try:
        if hasattr(run, "finish"):
            run.finish()
    except Exception:
        try:
            run.finish()
        except Exception:
            pass
