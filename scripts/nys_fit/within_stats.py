"""Within-capture statistics used to tune the nuisance model (wander and noise).

Usage: uv run --with pyarrow --with numpy python -I scripts/nys_fit/within_stats.py real /tmp/nys_data
       uv run --with pyarrow --with numpy python -I scripts/nys_fit/within_stats.py sim /tmp/sim.json
"""

import json
import sys
from pathlib import Path

import numpy as np

DEAD = list(range(2, 32, 4))
ACTIVE = [c for c in range(32) if c not in DEAD]


def load(kind: str, path: Path) -> tuple[list[np.ndarray], list[np.ndarray]]:
    if kind == "real":
        import pyarrow.parquet as pq

        baselines, samples = [], []
        for p in sorted(path.glob("*.parquet")):
            table = pq.read_table(p, columns=["baseline_raw", "sample_raw"])
            baselines += [np.asarray(b) for b in table.column("baseline_raw").to_pylist()]
            samples += [np.asarray(s) for s in table.column("sample_raw").to_pylist()]
        return baselines, samples
    records = json.loads(path.read_text())
    return [np.asarray(r["baseline"]) for r in records], [np.asarray(r["sample"]) for r in records]


def stats(baselines: list[np.ndarray], samples: list[np.ndarray]) -> dict[str, float]:
    within_b = np.array([np.std(b[:, ACTIVE] / b[:, ACTIVE].mean(axis=0), axis=0) for b in baselines])
    within_s = np.array([np.std(s[:, ACTIVE] / b[:, ACTIVE].mean(axis=0), axis=0) for b, s in zip(baselines, samples)])
    peak = np.array([(s[:, ACTIVE].max(axis=0) - s[:, ACTIVE].mean(axis=0)) / b[:, ACTIVE].mean(axis=0) for b, s in zip(baselines, samples)])
    return {
        "base_med": float(np.median(within_b)),
        "base_p90": float(np.percentile(within_b, 90)),
        "samp_med": float(np.median(within_s)),
        "samp_p90": float(np.percentile(within_s, 90)),
        "peak_med": float(np.median(peak)),
    }


if __name__ == "__main__":
    print(json.dumps(stats(*load(sys.argv[1], Path(sys.argv[2])))))
