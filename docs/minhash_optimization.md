# MinHash Optimization

Summary of profiling and optimizations for `scripts/data_prep/minhash_dedupe.py`.

## Finding

- The original `minhash_sig` implementation computed a fresh `sha256(shingle + salt)` per permutation per shingle. Profiling showed signature generation dominated runtime.

## Action taken

- Added `minhash_sig_fast` which:
  - Computes a single 64-bit hash per shingle (one sha256 per shingle)
  - Applies `num_perm` random linear hash functions `(a*x + b)` vectorized with NumPy when available
  - Falls back to a deterministic, faster pure-Python approach if NumPy is not available

- Changed `minhash_dedupe` to accept `--sig-method` (`fast` or `original`) and default to `fast`.

## Benchmark (example run)

On a synthetic sample (306 documents, doc length <= 1000, `num_perm=64`):

- Original `minhash_sig`: ~16.38s total (≈0.0535s/doc)
- `minhash_sig_fast`: ~0.48s total (≈0.00156s/doc)

This is ~30–40x speedup for signature generation in this scenario.

## Notes and recommendations

- `numpy` significantly improves performance; encourage installing `numpy` in CI and production environments where dedup will run at scale.
- The `fast` method is safe and deterministic (seeded RNG); use it as default for production workflows.
- Further improvements could port the algorithm to a C extension or use specialized libraries (e.g., `datasketch`) if that's desirable for portability.

## Tests

- Added unit tests to verify the `fast` implementation yields similar dedup results to `original` on small sample datasets (`tests/test_minhash_fast.py`).

