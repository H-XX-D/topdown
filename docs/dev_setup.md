# Developer environment setup

This file explains how to create a development environment for the repository.

Quick start (recommended):

```bash
# create a venv and install dev deps (CPU-only torch optional)
bash scripts/dev/setup_dev_env.sh --venv .venv
# or with CPU PyTorch
bash scripts/dev/setup_dev_env.sh --venv .venv --install-torch

# activate
source .venv/bin/activate
```

Notes:
- `requirements-dev.txt` contains optional training and experiment-tracking packages (W&B, transformers, PEFT).
- We prefer using the `--install-torch` flag when you want CPU-only PyTorch; for GPU installs use official PyTorch instructions for your CUDA version.
- CI uses offline-mode runs for the W&B example to avoid reliance on external services.
