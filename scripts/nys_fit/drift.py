"""How much of the real smellprint on active channels is baseline drift?

Usage: uv run --with pyarrow --with numpy python -I scripts/nys_fit/drift.py /tmp/nys_data
"""

import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ACTIVE = np.setdiff1d(np.arange(32), np.arange(2, 32, 4))
INERT = {"steel", "glass", "porcelain", "brass", "aluminum", "iron", "copper"}


def main() -> None:
    directory = Path(sys.argv[1])
    columns = ["baseline_raw", "sample_raw", "smellprint_vector", "material_label", "humidity", "temperature", "session", "sample_idx", "object_idx"]
    data: dict[str, list] = {c: [] for c in columns}
    for path in sorted(directory.glob("*.parquet")):
        table = pq.read_table(path, columns=columns)
        for c in columns:
            data[c].extend(table.column(c).to_pylist())
    n = len(data["smellprint_vector"])
    prints = np.asarray(data["smellprint_vector"])[:, ACTIVE]
    labels = np.asarray([m or "none" for m in data["material_label"]])
    slope = np.zeros((n, len(ACTIVE)))
    curvature = np.zeros((n, len(ACTIVE)))
    tb = np.zeros(n)
    ts = np.zeros(n)
    mean_shift = np.zeros((n, len(ACTIVE)))
    for i in range(n):
        b = np.asarray(data["baseline_raw"][i])[:, ACTIVE]
        s = np.asarray(data["sample_raw"][i])[:, ACTIVE]
        r0 = b.mean(axis=0)
        t = np.arange(b.shape[0]) - (b.shape[0] - 1) / 2
        slope[i] = (t @ (b / r0 - 1)) / (t @ t)  # relative change per row
        tb[i] = b.shape[0]
        ts[i] = s.shape[0]
        mean_shift[i] = s.mean(axis=0) / r0 - 1
    # drift extrapolated to the middle of the sample window, if contiguous
    lag = tb / 2 + ts / 2
    predicted = slope * lag[:, None]
    print("median |slope| per row (relative):", np.median(np.abs(slope)).round(7))
    print("corr(mean sample shift, extrapolated baseline drift) per channel, median:",
          np.median([np.corrcoef(mean_shift[:, k], predicted[:, k])[0, 1] for k in range(len(ACTIVE))]).round(3))
    for k in range(3):
        fit = np.polyfit(predicted[:, k], mean_shift[:, k], 1)
        print(f"  ch {ACTIVE[k]}: mean_shift = {fit[0]:.2f} * extrapolated + {fit[1]:.2e}")
    residual = mean_shift - predicted
    print("variance explained by drift extrapolation:",
          (1 - residual.var(axis=0) / mean_shift.var(axis=0)).round(2))

    # common mode: first PC of the mean sample shift
    centered = mean_shift - mean_shift.mean(axis=0)
    _, sv, vt = np.linalg.svd(centered, full_matrices=False)
    print("mean-shift PCA explained:", (sv[:5] ** 2 / (sv**2).sum()).round(3))
    print("PC1 loadings (sign-normalized):", (vt[0] * np.sign(vt[0].sum())).round(2))

    # sequential structure: first sample of an object vs second (repeat at a new position)
    sample_idx = np.asarray(data["sample_idx"])
    for value in np.unique(sample_idx)[:3]:
        mask = sample_idx == value
        print(f"sample_idx={value}: n={mask.sum()} median mean_shift {np.median(mean_shift[mask]):.2e} median slope {np.median(slope[mask]):.2e}")

    # per-material detrended excess vs inert blanks, active channels only
    inert = np.isin(labels, list(INERT))
    blank = residual[inert]
    blank_mean = blank.mean(axis=0)
    blank_sd = blank.std(axis=0)
    print("\nmaterial   n   median z (detrended mean shift vs inert)   |excess| x1e4")
    order = sorted(set(labels), key=lambda m: -(labels == m).sum())
    for m in order:
        mask = labels == m
        if mask.sum() < 40 or m in INERT:
            continue
        delta = residual[mask].mean(axis=0) - blank_mean
        z = np.abs(delta) / (blank_sd / np.sqrt(mask.sum()))
        print(f"  {m:16s} {mask.sum():4d}  {np.median(z):6.1f}  {np.linalg.norm(delta) * 1e4:7.2f}")
    np.save("/tmp/nys_data/../nys_active_residual.npy", residual)


if __name__ == "__main__":
    main()
