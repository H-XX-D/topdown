import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]
OUT = HERE / "models" / "lora_smoke"


def test_lora_dry_run_creates_model(tmp_path):
    out = tmp_path / "lora_smoke"
    cmd = [
        "python3",
        "scripts/train/lora_finetune_example.py",
        "--dry-run",
        "--steps",
        "3",
        "--out-dir",
        str(out),
    ]
    subprocess.check_call(cmd)
    assert (out / "lora_finetuned_model.pt").exists()
