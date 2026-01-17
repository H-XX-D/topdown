"""Profile MinHash implementation to find hotspots.

Usage:
  python3 scripts/data_prep/profile_minhash.py --n 1000 --doc_len 500 --num_perm 64

Prints simple timing for shingling, signature generation, and LSH bucketing, and prints cProfile stats for the signature generation.
"""
import argparse
import random
import string
import time
import cProfile
import pstats
import io
import sys
import pathlib

# make repo root importable
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from scripts.data_prep import minhash_dedupe as md


def random_doc(length):
    # generate a random 'text' document (letters + spaces)
    chars = string.ascii_lowercase + '     '
    return ''.join(random.choice(chars) for _ in range(length))


def load_sample(n, length):
    # try to read data/sample_data.jsonl if present; else generate synthetic
    docs = []
    try:
        import json
        with open('data/sample_data.jsonl') as f:
            for i, line in enumerate(f):
                if i >= n:
                    break
                docs.append(json.loads(line).get('text', '')[:length])
        if len(docs) >= n:
            return docs
    except Exception:
        pass
    for _ in range(n):
        docs.append(random_doc(length))
    return docs


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--n', type=int, default=1000)
    p.add_argument('--doc_len', type=int, default=500)
    p.add_argument('--k', type=int, default=5)
    p.add_argument('--num_perm', type=int, default=64)
    p.add_argument('--band_size', type=int, default=16)
    args = p.parse_args()

    docs = load_sample(args.n, args.doc_len)
    print(f"Loaded {len(docs)} documents (len <= {args.doc_len})")

    t0 = time.perf_counter()
    doc_shingles = [md.shingles(doc, k=args.k) for doc in docs]
    t1 = time.perf_counter()
    print(f"Shingling: {t1 - t0:.3f}s total, {((t1-t0)/len(docs)):.6f}s per doc")

    # time minhash signature generation (vectorized over docs)
    t0 = time.perf_counter()
    sigs = [md.minhash_sig(sh, num_perm=args.num_perm) for sh in doc_shingles]
    t1 = time.perf_counter()
    print(f"MinHash sigs (original): {t1 - t0:.3f}s total, {((t1-t0)/len(docs)):.6f}s per doc")

    t0 = time.perf_counter()
    sigs_fast = [md.minhash_sig_fast(sh, num_perm=args.num_perm) for sh in doc_shingles]
    t1 = time.perf_counter()
    print(f"MinHash sigs (fast): {t1 - t0:.3f}s total, {((t1-t0)/len(docs)):.6f}s per doc")

    # profile one signature generation using cProfile (fast version)
    pr = cProfile.Profile()
    pr.enable()
    _ = md.minhash_sig_fast(doc_shingles[0], num_perm=args.num_perm)
    pr.disable()
    s = io.StringIO()
    ps = pstats.Stats(pr, stream=s).sort_stats('cumulative')
    ps.print_stats(30)
    print("\nTop cProfile stats for minhash_sig on one doc:\n")
    print(s.getvalue())

    t0 = time.perf_counter()
    buckets = md.lsh_buckets(sigs, band_size=args.band_size)
    t1 = time.perf_counter()
    print(f"LSH bucketing: {t1 - t0:.3f}s total")


if __name__ == '__main__':
    main()
