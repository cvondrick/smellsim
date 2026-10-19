"""Extract fitting targets for the channel calibration from New York Smells.

Writes data/nys_targets.json with per-channel levels and noise, the readout model of the
non-sensing channels, the nuisance (inert-object) distribution and per-material mean responses
for the train and test object-level splits. All statistics are on the relative sample shift
(sample mean / baseline mean - 1).

Usage: uv run --with pyarrow --with numpy python -I scripts/nys_fit/extract_targets.py /tmp/nys_data data/nys_targets.json
"""

import json
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

DEAD = list(range(2, 32, 4))
ACTIVE = [c for c in range(32) if c not in DEAD]
INERT = ["steel", "glass", "porcelain", "brass", "aluminum", "iron", "copper"]


def load(directory: Path) -> dict[str, list]:
    columns = ["baseline_raw", "sample_raw", "smellprint_vector", "material_label", "split_objectlevel", "humidity", "temperature"]
    data: dict[str, list] = {c: [] for c in columns}
    for path in sorted(directory.glob("*.parquet")):
        table = pq.read_table(path, columns=columns)
        for c in columns:
            data[c].extend(table.column(c).to_pylist())
    return data


def dead_channel_model(baselines: list[np.ndarray], samples: list[np.ndarray]) -> dict[str, object]:
    """Non-sensing channels: per-channel two-level readout plus shared glitch episodes."""
    traces = [np.vstack([b[:, DEAD], s[:, DEAD]]) for b, s in zip(baselines, samples)]
    relative = [(t - np.median(t)) / np.median(t) for t in traces]
    stacked = np.concatenate(relative)
    small = np.abs(stacked) < 0.005
    low_fraction, low, high, jitter = [], [], [], []
    for k in range(len(DEAD)):
        v = stacked[small[:, k], k]
        is_low = v < -0.0006
        low_fraction.append(float(is_low.mean()))
        low.append(float(np.median(v[is_low])))
        high.append(float(np.median(v[~is_low])))
        jitter.append(float(np.std(v[~is_low] - np.median(v[~is_low]))))
    # glitch episodes: rows where the dead-channel mean departs > 1% from the capture median
    starts = 0
    rows = 0
    lengths: list[int] = []
    magnitudes: list[float] = []
    for r in relative:
        mean = r.mean(axis=1)
        flag = np.abs(mean) > 0.01
        rows += len(flag)
        run = 0
        for value, f in zip(mean, flag):
            if f:
                if run == 0:
                    starts += 1
                run += 1
                magnitudes.append(float(value))
            elif run:
                lengths.append(run)
                run = 0
        if run:
            lengths.append(run)
    magnitudes_array = np.asarray(magnitudes)
    return {
        "low_relative": low,
        "high_relative": high,
        "low_fraction": low_fraction,
        "jitter_relative": jitter,
        "level": float(np.median([np.median(t) for t in traces])),
        "episode_start_probability": starts / max(rows, 1),
        "episode_mean_rows": float(np.mean(lengths)) if lengths else 1.0,
        "episode_negative_fraction": float(np.mean(magnitudes_array < 0)) if magnitudes else 0.5,
        "episode_median_abs": float(np.median(np.abs(magnitudes_array))) if magnitudes else 0.0,
        "episode_p90_abs": float(np.percentile(np.abs(magnitudes_array), 90)) if magnitudes else 0.0,
    }


def wander_model(baselines: list[np.ndarray], white_noise: np.ndarray) -> dict[str, object]:
    """Common-mode slow wander within a capture: loading, time constant, amplitude distribution."""
    deviations = [b[:, ACTIVE] / b[:, ACTIVE].mean(axis=0) - 1 for b in baselines]
    white = white_noise[ACTIVE]
    # robust loading: leading eigenvector of the median-normalized per-capture covariance
    covs = [np.cov(r.T) for r in deviations if r.shape[0] >= 6]
    pooled = np.median(np.array(covs), axis=0) - np.diag(white**2)
    values, vectors = np.linalg.eigh(pooled)
    loading = vectors[:, -1] * np.sign(vectors[:, -1].sum())
    loading = loading / np.abs(loading).max()
    white_along = float(np.sqrt(np.sum((loading / np.linalg.norm(loading)) ** 2 * white**2)))
    amplitudes = []
    lag1 = []
    for r in deviations:
        component = r @ loading / (loading @ loading)
        excess = max(component.var() - white_along**2 / (loading @ loading), 0.0)
        amplitudes.append(np.sqrt(excess))
        if component.std() > 0 and len(component) > 3:
            lag1.append(np.corrcoef(component[:-1], component[1:])[0, 1])
    amplitudes_array = np.asarray(amplitudes)
    positive = amplitudes_array[amplitudes_array > 0]
    rho = float(np.clip(np.median(lag1), 0.05, 0.95))
    return {
        "loading": loading.tolist(),
        "lag1": rho,
        "amplitude_quantiles": {str(q): float(np.percentile(amplitudes_array, q)) for q in (10, 25, 50, 75, 90, 99)},
        "amplitude_log_median": float(np.log(np.median(positive))),
        "amplitude_log_sd": float(np.std(np.log(positive))),
        "amplitude_zero_fraction": float(np.mean(amplitudes_array <= 0)),
    }


def multivariate_t(x: np.ndarray) -> dict[str, object]:
    """EM fit of a multivariate Student-t (location, scale matrix, degrees of freedom)."""
    from math import lgamma, log, pi

    n, p = x.shape
    mu = np.median(x, axis=0)
    scale = np.cov(x.T)
    nu = 5.0
    for _ in range(150):
        diff = x - mu
        m = np.einsum("ij,jk,ik->i", diff, np.linalg.inv(scale), diff)
        weight = (nu + p) / (nu + m)
        mu = (weight[:, None] * x).sum(axis=0) / weight.sum()
        diff = x - mu
        scale = (weight[:, None] * diff).T @ diff / n
        _, logdet = np.linalg.slogdet(scale)
        m = np.einsum("ij,jk,ik->i", diff, np.linalg.inv(scale), diff)
        best = None
        for candidate in np.linspace(1.5, 30, 58):
            ll = n * (lgamma((candidate + p) / 2) - lgamma(candidate / 2) - p / 2 * log(candidate * pi) - 0.5 * logdet)
            ll -= (candidate + p) / 2 * np.log1p(m / candidate).sum()
            if best is None or ll > best[0]:
                best = (ll, candidate)
        nu = float(best[1])
    return {"mean": mu.tolist(), "scale": scale.tolist(), "nu": nu}


def pca_marginals(x: np.ndarray, levels: int = 201) -> dict[str, object]:
    """Mean, principal axes and empirical quantiles of each principal score (keeps skew/tails)."""
    mean = x.mean(axis=0)
    centered = x - mean
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    scores = centered @ vt.T
    probabilities = np.linspace(0, 100, levels)
    probabilities[0], probabilities[-1] = 0.1, 99.9
    return {
        "mean": mean.tolist(),
        "axes": vt.tolist(),
        "quantiles": [np.percentile(scores[:, k], probabilities).tolist() for k in range(scores.shape[1])],
    }


def main() -> None:
    directory, out = Path(sys.argv[1]), Path(sys.argv[2])
    data = load(directory)
    baselines = [np.asarray(b) for b in data["baseline_raw"]]
    samples = [np.asarray(s) for s in data["sample_raw"]]
    labels = np.asarray([m or "none" for m in data["material_label"]])
    split = np.asarray(data["split_objectlevel"])
    shift = np.array([s[:, ACTIVE].mean(axis=0) / b[:, ACTIVE].mean(axis=0) - 1 for b, s in zip(baselines, samples)])
    level = np.median([b.mean(axis=0) for b in baselines], axis=0)
    # white readout noise from the (quiet) sample windows; baseline windows also carry slow wander
    diffs = np.concatenate([np.diff(s, axis=0) / s.mean(axis=0) for s in samples])
    noise = np.median(np.abs(diffs), axis=0) / 0.6745 / np.sqrt(2)

    targets: dict[str, object] = {
        "source": "New York Smells (cvlab/new-york-smells, CC BY 4.0), olfaction parquet config",
        "active_channels": ACTIVE,
        "dead_channels": DEAD,
        "level": level.tolist(),
        "noise_relative": noise.tolist(),
        "baseline_rows_median": float(np.median([b.shape[0] for b in baselines])),
        "sample_rows_median": float(np.median([s.shape[0] for s in samples])),
        "dead_model": dead_channel_model(baselines, samples),
        "wander": wander_model(baselines, noise),
        "inert_materials": INERT,
        "splits": {},
    }
    for name in ("train", "test"):
        in_split = split == name
        inert = in_split & np.isin(labels, INERT)
        blank = shift[inert]
        materials = {}
        for material in sorted(set(labels[in_split])):
            mask = in_split & (labels == material)
            if mask.sum() < 20 or material in INERT:
                continue
            group = shift[mask]
            materials[material] = {
                "n": int(mask.sum()),
                "mean_shift": group.mean(axis=0).tolist(),
            }
        targets["splits"][name] = {
            "inert_t": multivariate_t(blank),
            "inert_pca": pca_marginals(blank),
            # a random subsample of real inert offset vectors, for bootstrap nuisance sampling
            "inert_vectors": [[float(f"{v:.4g}") for v in row] for row in blank[np.random.default_rng(0).permutation(len(blank))[:800]]],
            "inert_n": int(inert.sum()),
            "inert_mean_shift": blank.mean(axis=0).tolist(),
            "inert_cov_shift": np.cov(blank.T).tolist(),
            "materials": materials,
        }
    out.write_text(json.dumps(targets, indent=1))
    print(f"wrote {out}")
    print("dead model:", targets["dead_model"])
    print("train materials:", {m: v["n"] for m, v in targets["splits"]["train"]["materials"].items()})


if __name__ == "__main__":
    main()
