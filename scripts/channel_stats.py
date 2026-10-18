"""Channel statistics for real (New York Smells parquet) or simulated e-nose captures.

Usage:
  uv run --with pyarrow --with numpy python -I scripts/channel_stats.py real /path/to/parquet_dir
  uv run --with pyarrow --with numpy python -I scripts/channel_stats.py sim /path/to/sim.json
"""

import json
import sys
from pathlib import Path

import numpy as np


def load_real(directory: Path) -> dict[str, list]:
    import pyarrow.parquet as pq

    columns = ["baseline_raw", "sample_raw", "smellprint_vector", "humidity", "temperature", "material_label", "dist_to_object_cm"]
    tables = [pq.read_table(path, columns=columns) for path in sorted(directory.glob("*.parquet"))]
    data: dict[str, list] = {name: [] for name in columns}
    for table in tables:
        for name in columns:
            data[name].extend(table.column(name).to_pylist())
    return {
        "baseline": [np.asarray(rows, dtype=np.float64) for rows in data["baseline_raw"]],
        "sample": [np.asarray(rows, dtype=np.float64) for rows in data["sample_raw"]],
        "smellprint": np.asarray(data["smellprint_vector"], dtype=np.float64),
        "humidity": np.asarray(data["humidity"], dtype=np.float64),
        "label": data["material_label"],
    }


def load_sim(path: Path) -> dict[str, list]:
    records = json.loads(path.read_text())
    return {
        "baseline": [np.asarray(r["baseline"], dtype=np.float64) for r in records],
        "sample": [np.asarray(r["sample"], dtype=np.float64) for r in records],
        "smellprint": np.asarray([r["smellprint"] for r in records], dtype=np.float64),
        "humidity": np.asarray([r["rh"] for r in records], dtype=np.float64),
        "label": [r["label"] for r in records],
    }


def summarize(data: dict[str, list]) -> dict[str, object]:
    baselines = [b for b in data["baseline"] if b.ndim == 2 and b.shape[0] >= 4]
    samples = data["sample"]
    prints = data["smellprint"]
    n = len(prints)
    stats: dict[str, object] = {"n_samples": n}
    stats["baseline_T_median"] = float(np.median([b.shape[0] for b in data["baseline"]]))
    stats["sample_T_median"] = float(np.median([s.shape[0] for s in samples]))

    # absolute resistance scale per channel (median over captures of the baseline mean)
    base_means = np.array([b.mean(axis=0) for b in baselines])
    channel_level = np.median(base_means, axis=0)
    stats["baseline_level_min_median_max"] = [float(channel_level.min()), float(np.median(channel_level)), float(channel_level.max())]
    stats["baseline_level_spread_ratio"] = float(channel_level.max() / max(channel_level.min(), 1e-12))
    # session-to-session drift of the baseline (coefficient of variation across captures)
    cv = base_means.std(axis=0) / np.abs(base_means.mean(axis=0))
    stats["baseline_cv_across_captures_median"] = float(np.median(cv))

    # readout noise: std of first differences within the baseline / sqrt(2), relative to level
    noise = np.array([np.std(np.diff(b, axis=0), axis=0) / np.sqrt(2) / np.abs(b.mean(axis=0)) for b in baselines])
    stats["relative_noise_median"] = float(np.median(noise))
    # drift within the baseline window (relative change first to last row)
    drift = np.array([np.abs(b[-1] - b[0]) / np.abs(b.mean(axis=0)) for b in baselines])
    stats["within_baseline_change_median"] = float(np.median(drift))

    # smellprint magnitudes
    magnitude = np.abs(prints)
    per_capture_max = magnitude.max(axis=1)
    stats["smellprint_abs_median"] = float(np.median(magnitude))
    stats["capture_max_abs_p10_p50_p90_p99"] = [float(np.percentile(per_capture_max, q)) for q in (10, 50, 90, 99)]
    stats["fraction_negative_entries"] = float((prints < 0).mean())
    stats["smellprint_over_noise_median"] = float(np.median(per_capture_max) / max(stats["relative_noise_median"], 1e-12))

    # channel correlation structure
    centered = prints - prints.mean(axis=0)
    corr = np.corrcoef(prints.T)
    off_diag = corr[~np.eye(32, dtype=bool)]
    stats["channel_corr_mean"] = float(np.nanmean(off_diag))
    stats["channel_corr_p10_p50_p90"] = [float(np.nanpercentile(off_diag, q)) for q in (10, 50, 90)]
    raw_values = np.linalg.svd(centered, compute_uv=False) ** 2
    stats["pca_raw_explained_top3"] = [float(v) for v in (raw_values[:3] / raw_values.sum())]
    standardized = centered / (prints.std(axis=0) + 1e-15)
    std_values = np.linalg.svd(standardized, compute_uv=False) ** 2
    stats["pca_autoscaled_explained_top3"] = [float(v) for v in (std_values[:3] / std_values.sum())]
    stats["pca_autoscaled_components_for_90pct"] = int(np.searchsorted(np.cumsum(std_values) / std_values.sum(), 0.9) + 1)
    # how unequal are channel gains? ratio of strongest to weakest channel's median |S|
    channel_gain = np.median(magnitude, axis=0)
    stats["channel_gain_max_over_min"] = float(channel_gain.max() / max(channel_gain.min(), 1e-15))
    stats["channel_gain_rank_top5"] = [int(i) for i in np.argsort(-channel_gain)[:5]]

    # does the overall response sign follow a common mode? fraction of captures where >80% of channels share sign
    signs = np.sign(prints)
    shared = np.maximum((signs > 0).mean(axis=1), (signs < 0).mean(axis=1))
    stats["captures_with_80pct_same_sign"] = float((shared > 0.8).mean())

    # correlation of each channel with ambient humidity
    humidity = data["humidity"]
    if np.isfinite(humidity).all() and humidity.std() > 0:
        rh_corr = np.array([np.corrcoef(prints[:, i], humidity)[0, 1] for i in range(32)])
        stats["smellprint_vs_ambient_RH_corr_min_max"] = [float(np.nanmin(rh_corr)), float(np.nanmax(rh_corr))]

    # response time course: average normalized trajectory over the sample window for strong captures
    strong = np.argsort(-per_capture_max)[: max(5, n // 10)]
    trajectories = []
    for index in strong:
        base = data["baseline"][index]
        sample = data["sample"][index]
        if base.shape[0] == 0 or sample.shape[0] < 4:
            continue
        r0 = base.mean(axis=0)
        channel = int(np.argmax(np.abs(prints[index])))
        series = (sample[:, channel] - r0[channel]) / r0[channel]
        peak = series[np.argmax(np.abs(series))]
        if peak != 0:
            trajectories.append(series[:14] / peak)
    if trajectories:
        length = min(len(t) for t in trajectories)
        stats["strong_capture_mean_trajectory"] = [round(float(v), 2) for v in np.mean([t[:length] for t in trajectories], axis=0)]
    return stats


def main() -> None:
    kind, path = sys.argv[1], Path(sys.argv[2])
    data = load_real(path) if kind == "real" else load_sim(path)
    for key, value in summarize(data).items():
        print(f"{key:44s} {value}")


if __name__ == "__main__":
    main()
