# LoRA/PEFT Finetune Example

This is a minimal example to demonstrate how to plug LoRA (PEFT) into a training loop.

Usage (dry-run, recommended for CI):

```bash
python3 scripts/train/lora_finetune_example.py --dry-run --steps 5 --out-dir models/lora_smoke
```

Notes:
- The script supports a real finetune path but **requires** `transformers`, `torch`, and `peft` to be installed. If these packages are not available, run with `--dry-run` for a lightweight smoke test.
- For real experiments, prefer a small model and CPU-only mode for quick tests or use a dedicated GPU runner for proper finetuning.
