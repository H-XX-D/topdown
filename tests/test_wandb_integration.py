import os
import shutil
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parents[2]
MODEL_DIR = HERE / "models"
RUNS_DIR = HERE / "wandb_runs"


def test_train_wandb_offline(tmp_path):
    # run the example trainer in offline mode (stub logs to wandb_runs)
    env = os.environ.copy()
    env["WANDB_MODE"] = "offline"
    # ensure a clean runs dir
    if RUNS_DIR.exists():
        shutil.rmtree(RUNS_DIR)

    cmd = ["python3", "scripts/train/train_wandb_example.py", "--steps", "5", "--offline", "--out-dir", str(tmp_path / "models")]
    subprocess.check_call(cmd, env=env)

    # check model artifact
    assert (tmp_path / "models" / "wandb_example_model.pt").exists()
    # check that a wandb_runs file was created
    # look for any runs file under repo root (handles env / path differences)
    files = list(HERE.rglob("**/wandb_runs/*.jsonl"))
    assert len(files) >= 1, f"No wandb run files found under {HERE}, searched for **/wandb_runs/*.jsonl"