#!/usr/bin/env python3
"""Tiny training loop that demonstrates W&B logging (or stubbed offline logging).
This is not a real model trainer; it provides a reproducible template to wire W&B into
real training scripts.
"""
import argparse
import random
import time
from pathlib import Path
import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from scripts.train.wandb_helper import init_wandb, log_metrics, save_artifact, finish_run


def run_train(steps: int = 10, project: str = "parametrix", use_wandb: bool = True, offline: bool = False, out_dir: str = "models"):
    run = None
    if use_wandb:
        run = init_wandb(project=project, config={"steps": steps}, offline=offline)
    # simulate training
    loss = 10.0
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    for step in range(1, steps + 1):
        # fake training update
        loss *= 0.95 * (1 - random.random() * 0.01)
        metrics = {"loss": loss, "step": step}
        if run:
            log_metrics(run, metrics, step=step)
        else:
            print("step", step, "metrics", metrics)
        time.sleep(0.01)

    # write a small model artifact (placeholder)
    model_path = Path(out_dir) / "wandb_example_model.pt"
    with open(model_path, "w", encoding="utf-8") as f:
        f.write("fake-model")

    if run:
        save_artifact(run, str(model_path))
        finish_run(run)

    return str(model_path)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--steps", type=int, default=10)
    p.add_argument("--project", default="parametrix")
    p.add_argument("--no-wandb", dest="use_wandb", action="store_false")
    p.add_argument("--offline", action="store_true", help="Run in offline/stub mode")
    p.add_argument("--out-dir", default="models")
    args = p.parse_args()

    model = run_train(steps=args.steps, project=args.project, use_wandb=args.use_wandb, offline=args.offline, out_dir=args.out_dir)
    print("Model written to", model)
