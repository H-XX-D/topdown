#!/usr/bin/env bash
set -euo pipefail

VE_DIR=".venv"
REQS="requirements-dev.txt"

usage() {
  cat <<EOF
Usage: $0 [--venv <dir>] [--install-torch]

Creates a Python virtual environment and installs development dependencies from ${REQS}.
If --install-torch is provided, will attempt a CPU-only torch install (may take time).
EOF
}

INSTALL_TORCH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --venv) VE_DIR="$2"; shift 2;;
    --install-torch) INSTALL_TORCH=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1"; usage; exit 1;;
  esac
done

python3 -m venv "$VE_DIR"
source "$VE_DIR/bin/activate"
python -m pip install --upgrade pip
pip install -r "$REQS"

if [[ "$INSTALL_TORCH" -eq 1 ]]; then
  echo "Installing CPU-only PyTorch (this may take a while)"
  pip install "torch" "torchvision" "torchaudio" --index-url https://download.pytorch.org/whl/cpu
fi

echo "Development env ready. Activate with: source $VE_DIR/bin/activate"
