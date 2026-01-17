from scripts.data_prep.minhash_dedupe import minhash_dedupe


def make_records():
    # create records with some duplicates and near-duplicates
    texts = [
        "this is a sample document about cats and dogs",
        "this is a sample document about cats and dogs",
        "this is a sample document about cats and dogs and parrots",
        "completely different text unrelated",
        "completely different text unrelated",
    ]
    return [{"id": i, "text": t} for i, t in enumerate(texts)]


def test_fast_matches_original_on_small_sample():
    records = make_records()
    deduped_orig, report_orig = minhash_dedupe(records, k=5, num_perm=64, band_size=8, sim_thresh=0.9, sig_method="original")
    deduped_fast, report_fast = minhash_dedupe(records, k=5, num_perm=64, band_size=8, sim_thresh=0.9, sig_method="fast")

    # Both should keep the same number of records (or differ by at most 1 due to approximate nature)
    assert abs(report_orig["kept"] - report_fast["kept"]) <= 1
    # Ensure duplicates counted similarly
    assert abs(report_orig["duplicates"] - report_fast["duplicates"]) <= 1
