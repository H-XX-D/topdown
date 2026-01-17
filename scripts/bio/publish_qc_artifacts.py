#!/usr/bin/env python3
"""Copy QC artifacts (CSV & PNG) from results/ into experiments/plots/ for inclusion in docs.

Usage:
  python3 scripts/bio/publish_qc_artifacts.py --results-dir results --dest-dir experiments/plots

The script is safe to run multiple times; it will overwrite existing files with the same name.
"""

import argparse
import shutil
from pathlib import Path


def publish(results_dir: Path, dest_dir: Path, prefix: str = "sample_base_balance"):
    results_dir = results_dir.resolve()
    dest_dir = dest_dir.resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)

    csv_src = results_dir / f"{prefix}_positions.csv"
    png_src = results_dir / f"{prefix}_per_position.png"

    if not csv_src.exists() or not png_src.exists():
        raise FileNotFoundError(f"Missing artifacts in {results_dir}: {csv_src}, {png_src}")

    csv_dst = dest_dir / csv_src.name
    png_dst = dest_dir / png_src.name

    shutil.copy2(csv_src, csv_dst)
    shutil.copy2(png_src, png_dst)

    print(f"Copied {csv_src} -> {csv_dst}")
    print(f"Copied {png_src} -> {png_dst}")


def generate_html_report(dest_dir: Path, prefix: str = "sample_base_balance"):
    """Generate a minimal HTML report embedding the PNG and linking the CSV."""
    csv_name = f"{prefix}_positions.csv"
    png_name = f"{prefix}_per_position.png"
    csv_path = dest_dir / csv_name
    png_path = dest_dir / png_name

    if not csv_path.exists() or not png_path.exists():
        raise FileNotFoundError(f"Missing artifacts for HTML generation: {csv_path}, {png_path}")

    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Data QC Report - {prefix}</title>
  <style>body {{ font-family: Arial, sans-serif; max-width: 900px; margin: 2rem auto; }}</style>
</head>
<body>
  <h1>Data QC Report: {prefix}</h1>
  <p>Generated artifacts:</p>
  <ul>
    <li><a href="{csv_name}">{csv_name}</a></li>
    <li><a href="{png_name}">{png_name}</a></li>
  </ul>
  <h2>Per-position base composition</h2>
  <img src="{png_name}" alt="Per-position base composition" style="max-width:100%;height:auto;">
  <hr>
  <p>Created by <code>scripts/bio/publish_qc_artifacts.py</code></p>
</body>
</html>"""

    out_html = dest_dir / f"{prefix}_report.html"
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Wrote HTML report to {out_html}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--results-dir", default="results", help="Directory where compute_base_balance writes artifacts")
    p.add_argument("--dest-dir", default="experiments/plots", help="Destination directory to copy artifacts to")
    p.add_argument("--prefix", default="sample_base_balance", help="Prefix used for artifact filenames")
    p.add_argument("--html", action="store_true", help="Generate a simple HTML report that embeds the PNG and links the CSV")
    args = p.parse_args()

    publish(Path(args.results_dir), Path(args.dest_dir), args.prefix)
    if args.html:
        generate_html_report(Path(args.dest_dir), args.prefix)
