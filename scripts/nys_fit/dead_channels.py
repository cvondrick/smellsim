"""Time structure of the non-sensing channels: per-capture levels, dwell times, spikes.

Usage: uv run --with pyarrow --with numpy python -I scripts/nys_fit/dead_channels.py /tmp/nys_data
"""

import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

DEAD = list(range(2, 32, 4))


def main() -> None:
    columns = ["baseline_raw", "sample_raw", "smellprint_vector", "session"]
    data: dict[str, list] = {c: [] for c in columns}
    for path in sorted(Path(sys.argv[1]).glob("*.parquet")):
        table = pq.read_table(path, columns=columns)
        for c in columns:
            data[c].extend(table.column(c).to_pylist())
    traces = [np.vstack([np.asarray(b)[:, DEAD], np.asarray(s)[:, DEAD]]) for b, s in zip(data["baseline_raw"], data["sample_raw"])]
    capture_level = np.array([np.median(t) for t in traces])
    print("per-capture median level percentiles 1/5/50/95/99:", np.percentile(capture_level, [1, 5, 50, 95, 99]).round(4))
    # relative deviation of each row from the capture median
    deviations = np.concatenate([(t - np.median(t)) / np.median(t) for t in traces])
    print("row deviation percentiles 0.1/1/50/99/99.9 (x1e3):", (np.percentile(deviations, [0.1, 1, 50, 99, 99.9]) * 1e3).round(3))
    big = np.abs(deviations) > 0.01
    print("fraction of rows deviating > 1% from capture median:", big.mean().round(5))
    print("fraction of captures with any >1% deviation:", np.mean([np.any(np.abs((t - np.median(t)) / np.median(t)) > 0.01) for t in traces]).round(4))
    # two-level structure: values relative to capture median, binned
    hist, edges = np.histogram(deviations[np.abs(deviations) < 0.003], bins=30)
    print("histogram of small deviations (x1e3 bin centers : counts):")
    centers = (edges[:-1] + edges[1:]) / 2 * 1e3
    print("  ", " ".join(f"{c:.2f}:{h}" for c, h in zip(centers, hist)))
    # dwell: probability that the state stays the same from one row to the next
    stays = []
    lows = []
    for t in traces:
        high = np.median(t, axis=0)
        state = (t < high - 0.0012).astype(int)  # low state about 0.0026 below high
        lows.append(state.mean())
        stays.append((state[1:] == state[:-1]).mean())
    print(f"low-state fraction {np.mean(lows):.3f}, P(stay) {np.mean(stays):.3f} (independent draws would give {np.mean(lows) ** 2 + (1 - np.mean(lows)) ** 2:.3f})")
    # synchronization across the 8 channels: fraction of rows where all channels share state
    shared = []
    for t in traces:
        high = np.median(t, axis=0)
        state = t < high - 0.0012
        shared.append(np.mean(state.all(axis=1) | (~state).all(axis=1)))
    print(f"rows where all 8 dead channels share a state: {np.mean(shared):.3f}")
    prints = np.asarray(data["smellprint_vector"])[:, DEAD]
    print("dead smellprint percentiles 1/10/50/90/99 (x1e3):", (np.percentile(prints, [1, 10, 50, 90, 99]) * 1e3).round(3))


if __name__ == "__main__":
    main()
