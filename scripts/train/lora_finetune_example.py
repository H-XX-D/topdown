#!/usr/bin/env python3
"""Minimal LoRA/PEFT finetune example with a safe dry-run mode for CI.

Behavior:
- If `--dry-run` is set, performs a fake training loop and writes a model placeholder and logs to W&B (stub)
- If real mode is requested and dependencies (torch, transformers, peft) are available, it will attempt a tiny finetune using a small HF model

Usage (dry-run):
  python3 scripts/train/lora_finetune_example.py --dry-run --steps 5 --out-dir models/lora

If you want to run a real finetune, ensure `transformers`, `torch`, and `peft` are installed and run without `--dry-run`.
"""
import argparse
import os
import random
import time
from pathlib import Path

# optional wandb helper
try:
    from scripts.train.wandb_helper import init_wandb, log_metrics, save_artifact, finish_run
except Exception:
    init_wandb = None


def dry_run(steps: int, out_dir: str, project: str):
    run = init_wandb(project=project, offline=True) if init_wandb else None
    loss = 5.0
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    for step in range(1, steps + 1):
        loss *= 0.95 * (1.0 - random.random() * 0.01)
        metrics = {"loss": loss, "step": step}
        if run:
            log_metrics(run, metrics, step=step)
        else:
            print("step", step, "metrics", metrics)
        time.sleep(0.01)
    model_path = Path(out_dir) / "lora_finetuned_model.pt"
    model_path.write_text("lora-fake-model")
    if run:
        save_artifact(run, str(model_path))
        finish_run(run)
    print("Wrote model placeholder to", model_path)
    return str(model_path)


def try_real_finetune(model_name: str, steps: int, out_dir: str, project: str):
    # attempt to import heavy deps
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    except Exception as e:
        raise RuntimeError("Required packages for real finetune are not installed or available: " + str(e))

    # Very small example using a tiny random model for speed if available
    print("Starting real finetune (this may use CPU and be slow) on model", model_name)
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(model_name)

    # apply LoRA
    config = LoraConfig(r=8, lora_alpha=32, target_modules=["q_proj", "v_proj"], lora_dropout=0.05, bias="none", task_type="CAUSAL_LM")
    model = get_peft_model(model, config)

    model.train()

    Path(out_dir).mkdir(parents=True, exist_ok=True)
    run = init_wandb(project=project, offline=True) if init_wandb else None

    # dummy training loop over random data
    for step in range(1, steps + 1):
        # fake batch
        inputs = tokenizer("The quick brown fox", return_tensors="pt")
        outputs = model(**inputs, labels=inputs["input_ids"])  # may error for tiny random models
        loss = outputs.loss if hasattr(outputs, "loss") else torch.tensor(0.0)
        if run:
            log_metrics(run, {"loss": float(loss.detach().cpu().numpy())}, step=step)
        else:
            print("step", step, "loss", loss)
    model_path = Path(out_dir) / "lora_finetuned_model.pth"
    try:
        torch.save(model.state_dict(), str(model_path))
        if run:
            save_artifact(run, str(model_path))
            finish_run(run)
        print("Saved finetuned model to", model_path)
        return str(model_path)
    except Exception as e:
        raise RuntimeError("Failed saving model: " + str(e))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="hf-internal-testing/tiny-random-gpt2", help="HF model name (small)")
    p.add_argument("--steps", type=int, default=5)
    p.add_argument("--out-dir", default="models/lora")
    p.add_argument("--project", default="parametrix")
    p.add_argument("--dry-run", action="store_true", help="Do a lightweight dry run (no heavy deps needed)")
    args = p.parse_args()

    if args.dry_run:
        dry_run(steps=args.steps, out_dir=args.out_dir, project=args.project)
    else:
        try:
            try_real_finetune(model_name=args.model, steps=args.steps, out_dir=args.out_dir, project=args.project)
        except RuntimeError as e:
            print("Real finetune failed: ", e)
            print("Fallback: run with --dry-run or install transformers/torch/peft")
