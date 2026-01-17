# Data Quality Checks: Base Balance (per-position)

This document explains the `compute_base_balance.py` tool and how to reproduce plots for base composition per position.

Usage example:

```bash
python3 scripts/bio/compute_base_balance.py \
  --input data/sample_reads.fastq --format fastq \
  --per-position --csv --plot --out-prefix results/sample_base_balance
```

Expected outputs (relative to repo root):

- `results/sample_base_balance_positions.csv` — per-position base percentages
- `results/sample_base_balance_per_position.png` — per-position plot

CI note: The repository contains a GitHub Actions workflow `.github/workflows/plot_data_qc.yml` which runs the tool inside the `parametrix/edge-emulator:onnx-mpl` container to ensure plotting works even if `matplotlib` is not available locally.

Publishing artifacts

To include the generated CSV and plot in the repository for documentation or experiments, run the publish helper which copies artifacts from `results/` into `experiments/plots/`:

```bash
python3 scripts/bio/publish_qc_artifacts.py --results-dir results --dest-dir experiments/plots --prefix sample_base_balance
```

After running the script the plot will be available at `experiments/plots/sample_base_balance_per_position.png` and can be referenced in docs or READMEs.

Automated publishing

The workflow also publishes generated artifacts into the `artifacts/data-qc` branch when changes are detected. This is handled by the CI job `publish-artifacts` in `.github/workflows/plot_data_qc.yml` and ensures that generated plots are available in the repository for documentation and review.

HTML report

The CI job now also generates a minimal HTML report (`<prefix>_report.html`) that embeds the per-position PNG and links the CSV; the HTML is published to `artifacts/data-qc` alongside the CSV and PNG for easy review.
