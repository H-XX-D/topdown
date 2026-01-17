import subprocess
from pathlib import Path
import json

HERE = Path(__file__).resolve().parents[2]
INPUT = HERE / "data" / "validation_sample_unique.jsonl"
OUT = HERE / "data" / "validation_sample_deduped.jsonl"


def test_integrate_dedupe_runs_and_writes_outputs(tmp_path):
    # run the integrate_dedupe script with conservative params
    cmd = [
        "python3",
        "scripts/data_prep/integrate_dedupe.py",
        "--input",
        str(INPUT),
        "--output",
        str(OUT),
        "--num-perm",
        "128",
        "--band-size",
        "16",
        "--sim-thresh",
        "0.9",
    ]
    subprocess.check_call(cmd)

    assert OUT.exists(), "Expected output file to be written"
    meta = OUT.with_suffix(OUT.suffix + ".meta.json")
    assert meta.exists(), "Expected metadata sidecar file"

    with open(meta, "r", encoding="utf-8") as f:
        m = json.load(f)
    assert m["params"]["num_perm"] == 128
    assert m["params"]["band_size"] == 16
    assert "report" in m
