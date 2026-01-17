Papers curated from arXiv (topics: probabilistic hardware, ternary/2-bit quantization, quadratic networks, and hardware-aware training)

How to download PDFs

1. Install requirements: `pip install requests`
2. Run: `python scripts/fetch_arxiv_pdfs.py --download`

Downloaded PDFs will be saved to `docs/arxiv/pdfs/` as `<arxiv_id>.pdf`.

Notes
- The provided list is curated and small; you can edit `PAPERS` in `scripts/fetch_arxiv_pdfs.py` to add/remove entries.
- Adding large PDFs to git may increase repo size; consider adding `docs/arxiv/pdfs/` to `.gitignore` if you prefer not to commit binary PDFs.
- If you want, I can also add `metadata.csv` and `bibtex.bib` files with short summaries.
