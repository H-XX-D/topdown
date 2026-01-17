import shutil
from pathlib import Path
import tempfile
import os
import subprocess

HERE = Path(__file__).resolve().parents[2]
PUBLISH = HERE / "scripts" / "bio" / "publish_qc_artifacts.py"


def test_publish_copies_files(tmp_path):
    # create fake results dir with dummy files
    results = tmp_path / "results"
    results.mkdir()
    prefix = "sample_base_balance_test"
    csv = results / f"{prefix}_positions.csv"
    png = results / f"{prefix}_per_position.png"
    csv.write_text("pos,A,C,G,T,N\n1,50,0,0,0,50\n")
    png.write_bytes(b"PNG_dummy")

    dest = tmp_path / "plots"
    cmd = [
        "python3",
        str(PUBLISH),
        "--results-dir",
        str(results),
        "--dest-dir",
        str(dest),
        "--prefix",
        prefix,
    ]

    subprocess.check_call(cmd)

    assert (dest / csv.name).exists()
    assert (dest / png.name).exists()
    # check contents
    assert (dest / csv.name).read_text() == csv.read_text()
    assert (dest / png.name).read_bytes() == png.read_bytes()

    # test HTML generation
    cmd2 = ["python3", str(PUBLISH), "--results-dir", str(results), "--dest-dir", str(dest), "--prefix", prefix, "--html"]
    subprocess.check_call(cmd2)
    html = dest / f"{prefix}_report.html"
    assert html.exists(), "Expected HTML report to be created"
    txt = html.read_text()
    assert '<img' in txt and csv.name in txt
