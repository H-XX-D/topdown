#!/usr/bin/env python3
"""Integrate MinHash deduplication into a training data preprocessing step.

Example:
  python3 scripts/data_prep/integrate_dedupe.py --input data/training.jsonl --output data/training_deduped.jsonl --num-perm 128 --band-size 16 --sim-thresh 0.9

The script reads a JSONL file of records (with 'text' field), runs MinHash+LSH dedupe, writes deduped JSONL, and prints a small report.
"""
import argparse
import logging
from pathlib import Path
import json
import sys
import pathlib

# ensure repo root is importable when executed directly
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from scripts.data_prep.minhash_dedupe import read_jsonl, write_jsonl, minhash_dedupe

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")


def main():
    p = argparse.ArgumentParser(description="Integrate MinHash dedupe into preprocessing pipeline")
    p.add_argument("--input", required=True, help="Input JSONL training file")
    p.add_argument("--output", required=True, help="Output JSONL deduped file")
    p.add_argument("--k", type=int, default=5)
    p.add_argument("--num-perm", type=int, default=128)
    p.add_argument("--band-size", type=int, default=16)
    p.add_argument("--sim-thresh", type=float, default=0.9)
    p.add_argument("--sig-method", choices=["fast", "original"], default="fast")
    args = p.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    records = read_jsonl(str(input_path))
    logging.info("Read %d records from %s", len(records), input_path)

    deduped, report = minhash_dedupe(records, k=args.k, num_perm=args.num_perm, band_size=args.band_size, sim_thresh=args.sim_thresh, sig_method=args.sig_method)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_jsonl(str(out_path), deduped)

    logging.info("Wrote %d deduped records to %s", len(deduped), out_path)
    logging.info("Report: %s", report)

    # Write metadata sidecar for the run
    meta = {
        "input": str(input_path),
        "output": str(out_path),
        "params": {"k": args.k, "num_perm": args.num_perm, "band_size": args.band_size, "sim_thresh": args.sim_thresh, "sig_method": args.sig_method},
        "report": report,
    }
    meta_path = out_path.with_suffix(out_path.suffix + ".meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    logging.info("Wrote metadata to %s", meta_path)


if __name__ == "__main__":
    main()
