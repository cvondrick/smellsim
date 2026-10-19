"""Per-channel behavior of the real Cyranose in New York Smells (raw traces).

Usage: uv run --with pyarrow --with numpy python -I scripts/nys_fit/channels.py /tmp/nys_data
"""

import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq


def main() -> None:
    directory = Path(sys.argv[1])
    columns = ["baseline_raw", "sample_raw", "smellprint_vector", "material_label", "session"]
    data: dict[str, list] = {c: [] for c in columns}
    for path in sorted(directory.glob("*.parquet")):
        table = pq.read_table(path, columns=columns)
        for c in columns:
            data[c].extend(table.column(c).to_pylist())
    baselines = [np.asarray(b) for b in data["baseline_raw"]]
    samples = [np.asarray(s) for s in data["sample_raw"]]
    prints = np.asarray(data["smellprint_vector"])
    keep = [i for i, b in enumerate(baselines) if b.ndim == 2 and b.shape[0] >= 6 and samples[i].ndim == 2 and samples[i].shape[0] >= 6]
    print("captures with traces:", len(keep))

    level = np.median([baselines[i].mean(axis=0) for i in keep], axis=0)
    diffs = np.concatenate([np.diff(baselines[i], axis=0) / baselines[i].mean(axis=0) for i in keep])
    noise = np.median(np.abs(diffs), axis=0) / 0.6745 / np.sqrt(2)  # robust sigma of white noise
    big = (np.abs(diffs) > 10 * noise * np.sqrt(2)).mean(axis=0)  # fraction of jumps
    # quantization: most common nonzero absolute step in raw units
    raw_steps = np.concatenate([np.diff(baselines[i], axis=0) for i in keep])
    print("\nch  level    noise     jumps>10s  step_mode   sp_p50      sp_p90     sp_p99    frac_neg")
    for ch in range(32):
        steps = np.abs(raw_steps[:, ch])
        steps = steps[steps > 0]
        hist, edges = np.histogram(steps, bins=200, range=(0, np.percentile(steps, 99)))
        mode = edges[np.argmax(hist)] if steps.size else 0
        sp = prints[:, ch]
        print(f"{ch:2d}  {level[ch]:.3f}  {noise[ch]:.2e}  {big[ch]:.4f}     {mode:.2e}   {np.percentile(np.abs(sp), 50):.2e}  {np.percentile(np.abs(sp), 90):.2e}  {np.percentile(np.abs(sp), 99):.2e}  {(sp < 0).mean():.2f}")

    hot = np.arange(2, 32, 4)
    quiet = np.setdiff1d(np.arange(32), hot)
    # correlation structure inside each group
    for name, group in (("hot", hot), ("quiet", quiet)):
        c = np.corrcoef(prints[:, group].T)
        off = c[~np.eye(len(group), dtype=bool)]
        print(f"\n{name} channels {group.tolist()}: corr median {np.median(off):.2f}, p10 {np.percentile(off, 10):.2f}, p90 {np.percentile(off, 90):.2f}")
    cross = np.corrcoef(prints.T)[np.ix_(hot, quiet)]
    print(f"hot-vs-quiet corr median {np.median(cross):.2f}")

    # example hot-channel trace
    i = keep[5]
    np.set_printoptions(precision=4, suppress=True, linewidth=200)
    print("\nexample capture, hot channels baseline then sample:")
    print(np.vstack([baselines[i][:, hot], samples[i][:, hot]]))
    # does a hot channel's smellprint look like noise? compare (max - mean) to within-sample std
    ratio = []
    for i in keep:
        s = samples[i][:, hot]
        ratio.append((s.max(axis=0) - s.mean(axis=0)) / (s.std(axis=0) + 1e-12))
    print("hot: (max - mean)/std within sample, median:", np.median(ratio, axis=0).round(2))
    # sessions: is hot-channel behavior session dependent?
    sessions = np.asarray(data["session"])
    by_session = {s: np.median(np.abs(prints[sessions == s][:, hot])) for s in np.unique(sessions)}
    values = np.array(list(by_session.values()))
    print(f"hot |S| median per session: min {values.min():.2e} median {np.median(values):.2e} max {values.max():.2e}")


if __name__ == "__main__":
    main()
