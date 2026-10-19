"""Exploratory look at New York Smells smellprints: per-material signal vs. inert blanks.

Usage: uv run --with pyarrow --with numpy python -I scripts/nys_fit/explore.py /tmp/nys_data
"""

import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

INERT = {"steel", "glass", "porcelain", "brass", "aluminum", "chrome", "iron", "copper", "ceramic", "metal-other"}


def main() -> None:
    directory = Path(sys.argv[1])
    columns = ["smellprint_vector", "material_label", "humidity", "temperature", "pid", "indoor", "split_objectlevel"]
    rows: dict[str, list] = {c: [] for c in columns}
    for path in sorted(directory.glob("*.parquet")):
        table = pq.read_table(path, columns=columns)
        for c in columns:
            rows[c].extend(table.column(c).to_pylist())
    prints = np.asarray(rows["smellprint_vector"])
    labels = np.asarray([m if m is not None else "none" for m in rows["material_label"]])
    counts = Counter(labels)
    print("materials:", len(counts))
    print(sorted(counts.items(), key=lambda kv: -kv[1]))

    inert_mask = np.isin(labels, list(INERT))
    blank = prints[inert_mask]
    blank_mean = blank.mean(axis=0)
    blank_std = blank.std(axis=0)
    print(f"\ninert captures: {inert_mask.sum()}  materials: {sorted(set(labels[inert_mask]))}")
    np.set_printoptions(precision=5, suppress=True, linewidth=200)
    print("blank mean (x1e4):", blank_mean * 1e4)
    print("blank std  (x1e4):", blank_std * 1e4)

    print("\nper-material: n, |mean - blank| / (blank std/sqrt n) (median over channels), norm of excess (x1e4), cosine to foliage excess")
    excess: dict[str, np.ndarray] = {}
    for material, n in counts.most_common():
        if n < 25:
            continue
        group = prints[labels == material]
        delta = group.mean(axis=0) - blank_mean
        z = np.abs(delta) / (blank_std / np.sqrt(n))
        excess[material] = delta
        print(f"  {material:22s} n={n:4d}  median z={np.median(z):6.1f}  max z={z.max():6.1f}  |excess|={np.linalg.norm(delta) * 1e4:8.2f}")

    names = [m for m in excess if counts[m] >= 60]
    matrix = np.array([excess[m] / (np.linalg.norm(excess[m]) + 1e-12) for m in names])
    similarity = matrix @ matrix.T
    print("\ncosine similarity of excess patterns (materials with n>=60):")
    print("                 " + " ".join(f"{m[:7]:>7s}" for m in names))
    for i, m in enumerate(names):
        print(f"  {m[:14]:14s} " + " ".join(f"{v:7.2f}" for v in similarity[i]))

    # how much of the variance is common-mode? leading direction of all smellprints
    centered = prints - prints.mean(axis=0)
    _, singular, vt = np.linalg.svd(centered, full_matrices=False)
    print("\nleading direction of all smellprints (x100):", vt[0] * 100)
    print("explained:", (singular[:5] ** 2 / (singular**2).sum()).round(3))

    # relation to environment
    rh = np.asarray(rows["humidity"], dtype=float)
    t = np.asarray(rows["temperature"], dtype=float)
    pid = np.asarray(rows["pid"], dtype=float)
    score = centered @ vt[0]
    print("\nPC1 score corr with RH, T, PID:", [round(float(np.corrcoef(score, x)[0, 1]), 3) for x in (rh, t, pid)])
    for name, x in (("RH", rh), ("T", t), ("PID", pid)):
        corr = np.array([np.corrcoef(prints[:, i], x)[0, 1] for i in range(32)])
        print(f"channel corr with {name}: min {corr.min():.3f} max {corr.max():.3f}")


if __name__ == "__main__":
    main()
