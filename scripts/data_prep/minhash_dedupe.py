"""
Prototype MinHash + LSH deduplication for JSONL datasets.
- Character-shingle (k) -> set
- MinHash signatures via multiple seeded sha256 hashes (num_perm)
- LSH banding to find candidate near-duplicates

This is a lightweight, dependency-free prototype intended for mid-size datasets.
"""

import argparse
import hashlib
import json
import logging
from collections import defaultdict
from typing import List, Set, Tuple

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")


def shingles(text: str, k: int = 5) -> Set[str]:
    text = text.replace("\n", " ")
    s = set()
    if len(text) <= k:
        s.add(text)
        return s
    for i in range(len(text) - k + 1):
        s.add(text[i : i + k])
    return s


def minhash_sig(shingles: Set[str], num_perm: int = 64) -> List[int]:
    sig = []
    for i in range(num_perm):
        minv = None
        salt = str(i).encode("utf-8")
        for sh in shingles:
            h = hashlib.sha256(sh.encode("utf-8") + salt).hexdigest()
            val = int(h, 16)
            if minv is None or val < minv:
                minv = val
        sig.append(minv if minv is not None else 0)
    return sig


def minhash_sig_fast(shingles: Set[str], num_perm: int = 64, rng_seed: int = 42) -> List[int]:
    """Faster MinHash signature:
    - compute one hash per shingle (sha256 -> 64-bit int)
    - use random linear hash functions (a*x + b) mod 2**64 and take minima across shingles
    - uses numpy if available for vectorized operations
    """
    if not shingles:
        return [0] * num_perm

    # compute one 64-bit hash per shingle
    try:
        import numpy as np
    except Exception:
        # fallback pure-Python (still faster than repeated sha256 per permutation)
        sh_hashes = [int(hashlib.sha256(s.encode("utf-8")).hexdigest(), 16) & ((1 << 61) - 1) for s in shingles]
        import random

        rng = random.Random(rng_seed)
        a = [rng.randrange(1, (1 << 61) - 1) for _ in range(num_perm)]
        b = [rng.randrange(0, (1 << 61) - 1) for _ in range(num_perm)]

        sig = []
        for ai, bi in zip(a, b):
            minv = None
            for h in sh_hashes:
                val = (ai * h + bi) & ((1 << 61) - 1)
                if minv is None or val < minv:
                    minv = val
            sig.append(minv if minv is not None else 0)
        return sig

    # numpy path
    sh_hashes = np.fromiter((int.from_bytes(hashlib.sha256(s.encode('utf-8')).digest()[:8], 'little') for s in shingles), dtype=np.uint64)
    rng = np.random.default_rng(rng_seed)
    a = rng.integers(1, (1 << 61) - 1, size=num_perm, dtype=np.uint64)
    b = rng.integers(0, (1 << 61) - 1, size=num_perm, dtype=np.uint64)

    # vectorized compute: (a[:,None] * sh_hashes[None,:] + b[:,None]) mod 2**64 (uint64 wrap)
    mat = (a[:, None].astype(np.uint64) * sh_hashes[None, :].astype(np.uint64)) + b[:, None].astype(np.uint64)
    sig = np.min(mat, axis=1).astype(np.uint64).tolist()
    return sig


def lsh_buckets(sig: List[int], band_size: int = 8) -> List[Tuple[int, str]]:
    buckets = []
    num_bands = len(sig) // band_size
    for b in range(num_bands):
        start = b * band_size
        band = tuple(sig[start : start + band_size])
        # bucket by hash of band
        h = hashlib.sha256(json.dumps(band, sort_keys=True).encode("utf-8")).hexdigest()
        buckets.append((b, h))
    return buckets


def read_jsonl(path: str) -> List[dict]:
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
    return out


def write_jsonl(path: str, records: List[dict]):
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def minhash_dedupe(records: List[dict], k: int = 5, num_perm: int = 64, band_size: int = 8, sim_thresh: float = 0.9, sig_method: str = "fast") -> Tuple[List[dict], dict]:
    # Precompute shingles and signatures
    sigs = {}
    shingles_map = {}
    for idx, rec in enumerate(records):
        text = rec.get("text") or rec.get("content") or ""
        sh = shingles(text, k=k)
        shingles_map[idx] = sh
        if sig_method == "fast":
            sigs[idx] = minhash_sig_fast(sh, num_perm=num_perm)
        else:
            sigs[idx] = minhash_sig(sh, num_perm=num_perm)

    # LSH buckets: band -> list of idx
    buckets = defaultdict(list)
    for idx, sig in sigs.items():
        for b, h in lsh_buckets(sig, band_size=band_size):
            buckets[(b, h)].append(idx)

    # For each record, find candidates from its buckets and pick canonical representative
    canonical = {}
    assigned = set()
    report = {"input": len(records), "kept": 0, "duplicates": 0}

    for idx, rec in enumerate(records):
        if idx in assigned:
            continue
        # find candidates
        sig = sigs[idx]
        cand = set()
        for b, h in lsh_buckets(sig, band_size=band_size):
            cand.update(buckets[(b, h)])
        # naive exact similarity with Jaccard of shingles for candidates
        sh = shingles_map[idx]
        best = idx
        for c in cand:
            if c == idx:
                continue
            shc = shingles_map[c]
            inter = len(sh & shc)
            union = len(sh | shc)
            j = inter / union if union > 0 else 0.0
            if j >= sim_thresh:
                assigned.add(c)
                report["duplicates"] += 1
        canonical[idx] = rec
        report["kept"] += 1

    deduped = list(canonical.values())
    return deduped, report


def main():
    p = argparse.ArgumentParser(description="MinHash + LSH dedupe prototype")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--k", type=int, default=5)
    p.add_argument("--num-perm", type=int, default=64)
    p.add_argument("--band-size", type=int, default=8)
    p.add_argument("--sim-thresh", type=float, default=0.9)
    p.add_argument("--sig-method", choices=["fast", "original"], default="fast", help="Signature method to use: 'fast' or 'original'")
    args = p.parse_args()

    records = read_jsonl(args.input)
    logging.info("Read %d records", len(records))
    deduped, report = minhash_dedupe(records, k=args.k, num_perm=args.num_perm, band_size=args.band_size, sim_thresh=args.sim_thresh, sig_method=args.sig_method)
    write_jsonl(args.output, deduped)
    logging.info("Wrote %d deduped records", len(deduped))
    logging.info("Report: %s", report)


if __name__ == "__main__":
    main()
