# Weights & Biases (W&B) integration

This document explains the W&B example training script and how to run it.

Usage (offline mode - no external network):

```bash
python3 scripts/train/train_wandb_example.py --steps 10 --offline --out-dir models
```

Usage (online mode, requires `wandb` installed and credentials):

```bash
python3 scripts/train/train_wandb_example.py --steps 100 --project my-project
```

Notes
- The script uses `scripts/train/wandb_helper.py` which falls back to a local JSONL-based stub if `wandb` is not available or if `--offline` is passed.
- CI should run the example script in offline mode to validate that training/artifact I/O and logging hooks work without network access.
