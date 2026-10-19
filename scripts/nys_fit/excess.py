"""Directions spanned by per-material responses on the active channels (sample mean - baseline mean).

Usage: uv run --with pyarrow --with numpy python -I scripts/nys_fit/excess.py /tmp/nys_data
"""

import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ACTIVE = np.setdiff1d(np.arange(32), np.arange(2, 32, 4))
INERT = {"steel", "glass", "porcelain", "brass", "aluminum", "iron", "copper"}


def main() -> None:
    directory = Path(sys.argv[1])
    columns = ["baseline_raw", "sample_raw", "material_label"]
    data: dict[str, list] = {c: [] for c in columns}
    for path in sorted(directory.glob("*.parquet")):
        table = pq.read_table(path, columns=columns)
        for c in columns:
            data[c].extend(table.column(c).to_pylist())
    labels = np.asarray([m or "none" for m in data["material_label"]])
    shift = np.array([
        np.asarray(s)[:, ACTIVE].mean(axis=0) / np.asarray(b)[:, ACTIVE].mean(axis=0) - 1
        for b, s in zip(data["baseline_raw"], data["sample_raw"])
    ])
    inert = np.isin(labels, list(INERT))
    blank_mean = shift[inert].mean(axis=0)
    blank_cov = np.cov((shift[inert] - blank_mean).T)
    # whitening by the nuisance covariance: directions where materials stand out above nuisance
    evals, evecs = np.linalg.eigh(blank_cov)
    whiten = evecs @ np.diag(1 / np.sqrt(np.maximum(evals, 1e-14))) @ evecs.T
    informative = [m for m in sorted(set(labels), key=lambda m: -(labels == m).sum()) if (labels == m).sum() >= 40 and m not in INERT]
    excess = {}
    whitened = {}
    for m in informative:
        group = shift[labels == m]
        delta = group.mean(axis=0) - blank_mean
        excess[m] = delta
        whitened[m] = whiten @ delta * np.sqrt(len(group))  # z-like vector
    strong = [m for m in informative if np.linalg.norm(whitened[m]) > 12]
    np.set_printoptions(precision=2, suppress=True, linewidth=220)
    print("blank mean shift x1e4:", blank_mean * 1e4)
    print("strong materials (whitened norm > 12):", [(m, round(float(np.linalg.norm(whitened[m])), 1)) for m in strong])
    print("\nexcess x1e4 (active channels):")
    for m in strong:
        print(f"  {m:12s}", excess[m] * 1e4)
    matrix = np.array([excess[m] / np.linalg.norm(excess[m]) for m in strong])
    print("\ncosine similarity of raw excess directions:")
    for i, m in enumerate(strong):
        print(f"  {m[:10]:10s}", (matrix @ matrix.T)[i])
    wmatrix = np.array([whitened[m] for m in strong])
    sv = np.linalg.svd(wmatrix, compute_uv=False)
    print("\nsingular values of whitened excess matrix (independent chemical directions above nuisance):", sv.round(1))
    print("fraction:", (sv**2 / (sv**2).sum()).round(3))
    # null distribution: same computation on random splits of inert captures
    rng = np.random.default_rng(0)
    null = []
    inert_idx = np.flatnonzero(inert)
    for _ in range(len(strong)):
        pick = rng.choice(inert_idx, size=100, replace=False)
        null.append(whiten @ (shift[pick].mean(axis=0) - blank_mean) * np.sqrt(100))
    print("null singular values (random inert subsets, n=100):", np.linalg.svd(np.array(null), compute_uv=False).round(1))


if __name__ == "__main__":
    main()
