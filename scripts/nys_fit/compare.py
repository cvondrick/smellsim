"""Channel-by-channel comparison of real New York Smells captures with simulated captures.

Usage:
  uv run --with pyarrow --with numpy --with scikit-learn python -I scripts/nys_fit/compare.py \
      /tmp/nys_data /tmp/sim_nys/sim_nys.json [/tmp/sim_nys/sim_lit.json ...]
"""

import json
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

DEAD = list(range(2, 32, 4))
ACTIVE = [c for c in range(32) if c not in DEAD]
INERT = {"steel", "glass", "porcelain", "brass", "aluminum", "iron", "copper"}


def load_real(directory: Path) -> dict:
    columns = ["baseline_raw", "sample_raw", "smellprint_vector", "material_label", "split_objectlevel"]
    data: dict[str, list] = {c: [] for c in columns}
    for path in sorted(directory.glob("*.parquet")):
        table = pq.read_table(path, columns=columns)
        for c in columns:
            data[c].extend(table.column(c).to_pylist())
    labels = ["inert" if m in INERT else (m or "none") for m in data["material_label"]]
    return {
        "baseline": [np.asarray(b) for b in data["baseline_raw"]],
        "sample": [np.asarray(s) for s in data["sample_raw"]],
        "smellprint": np.asarray(data["smellprint_vector"]),
        "label": np.asarray(labels),
    }


def load_sim(path: Path) -> dict:
    records = json.loads(path.read_text())
    return {
        "baseline": [np.asarray(r["baseline"]) for r in records],
        "sample": [np.asarray(r["sample"]) for r in records],
        "smellprint": np.asarray([r["smellprint"] for r in records]),
        "label": np.asarray([r["label"] for r in records]),
    }


def features(data: dict) -> dict:
    prints = data["smellprint"]
    shift = np.array([s.mean(axis=0) / b.mean(axis=0) - 1 for b, s in zip(data["baseline"], data["sample"])])
    diffs = np.concatenate([np.diff(b, axis=0) / b.mean(axis=0) for b in data["baseline"]])
    return {
        "prints": prints,
        "shift": shift,
        "median_abs": np.median(np.abs(prints), axis=0),
        "frac_neg": (prints < 0).mean(axis=0),
        "noise": np.median(np.abs(diffs), axis=0) / 0.6745 / np.sqrt(2),
        "level": np.median([b.mean(axis=0) for b in data["baseline"]], axis=0),
        "corr": np.corrcoef(prints[:, ACTIVE].T),
        "label": data["label"],
    }


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra = np.argsort(np.argsort(a))
    rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def material_cosines(real: dict, sim: dict) -> dict[str, float]:
    out = {}
    real_inert = real["shift"][real["label"] == "inert"][:, ACTIVE].mean(axis=0)
    sim_inert = sim["shift"][sim["label"] == "inert"][:, ACTIVE].mean(axis=0)
    for material in sorted(set(sim["label"])):
        if material == "inert":
            continue
        r = real["shift"][real["label"] == material][:, ACTIVE]
        s = sim["shift"][sim["label"] == material][:, ACTIVE]
        if len(r) < 40 or len(s) < 20:
            continue
        a = r.mean(axis=0) - real_inert
        b = s.mean(axis=0) - sim_inert
        out[material] = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-15))
    return out


def domain_accuracy(real: np.ndarray, sim: np.ndarray, seed: int = 0) -> float:
    rng = np.random.default_rng(seed)
    n = min(len(real), len(sim))
    x = np.vstack([real[rng.choice(len(real), n, replace=False)], sim[rng.choice(len(sim), n, replace=False)]])
    y = np.r_[np.zeros(n), np.ones(n)]
    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0))
    return float(cross_val_score(model, x, y, cv=5).mean())


def main() -> None:
    real = features(load_real(Path(sys.argv[1])))
    print(f"real: {len(real['prints'])} captures")
    for sim_path in sys.argv[2:]:
        sim = features(load_sim(Path(sim_path)))
        print(f"\n=== {sim_path} ({len(sim['prints'])} captures)")
        print(f"level      spearman {spearman(real['level'], sim['level']):.2f}   median ratio {np.median(sim['level'] / real['level']):.3g}")
        print(f"noise      spearman {spearman(real['noise'], sim['noise']):.2f}   median ratio {np.median(sim['noise'] / real['noise']):.2f}")
        print(f"|smellprint| per channel: spearman {spearman(real['median_abs'], sim['median_abs']):.2f}   "
              f"median ratio active {np.median(sim['median_abs'][ACTIVE] / real['median_abs'][ACTIVE]):.2f}   "
              f"dead {np.median(sim['median_abs'][DEAD] / real['median_abs'][DEAD]):.2f}")
        print(f"fraction negative: real active {real['frac_neg'][ACTIVE].mean():.2f} dead {real['frac_neg'][DEAD].mean():.2f} | "
              f"sim active {sim['frac_neg'][ACTIVE].mean():.2f} dead {sim['frac_neg'][DEAD].mean():.2f}")
        off = ~np.eye(len(ACTIVE), dtype=bool)
        print(f"active-channel correlation matrix: entrywise corr {np.corrcoef(real['corr'][off], sim['corr'][off])[0, 1]:.2f}, "
              f"median real {np.median(real['corr'][off]):.2f} sim {np.median(sim['corr'][off]):.2f}")
        real_shift_corr = np.corrcoef(real["shift"][:, ACTIVE].T)
        sim_shift_corr = np.corrcoef(sim["shift"][:, ACTIVE].T)
        print(f"active-channel mean-shift correlation matrix: entrywise corr {np.corrcoef(real_shift_corr[off], sim_shift_corr[off])[0, 1]:.2f}")
        cosines = material_cosines(real, sim)
        print("per-material excess cosine (real vs sim):", {k: round(v, 2) for k, v in cosines.items()})
        print(f"   mean {np.mean(list(cosines.values())):.2f}")
        print(f"domain classifier accuracy on smellprints (0.5 = indistinguishable): {domain_accuracy(real['prints'], sim['prints']):.3f}")
        print(f"domain classifier accuracy on active-channel mean shifts: {domain_accuracy(real['shift'][:, ACTIVE], sim['shift'][:, ACTIVE]):.3f}")


def diagnose(real_path: str, sim_path: str) -> None:
    """Which statistics give the simulation away?"""
    real = features(load_real(Path(real_path)))
    sim = features(load_sim(Path(sim_path)))
    rs, ss = real["shift"][:, ACTIVE], sim["shift"][:, ACTIVE]
    print("active mean-shift std ratio sim/real per channel:", np.round(ss.std(axis=0) / rs.std(axis=0), 2))
    print("active mean-shift mean (x1e5) real:", np.round(rs.mean(axis=0) * 1e5, 1))
    print("active mean-shift mean (x1e5) sim: ", np.round(ss.mean(axis=0) * 1e5, 1))

    def kurtosis(x: np.ndarray) -> np.ndarray:
        z = (x - x.mean(axis=0)) / x.std(axis=0)
        return (z**4).mean(axis=0) - 3

    print("excess kurtosis of mean shift, median over channels: real", np.median(kurtosis(rs)).round(1), "sim", np.median(kurtosis(ss)).round(1))
    # project on the leading real direction and compare quantiles
    centered = rs - rs.mean(axis=0)
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    for k in range(3):
        pr = rs @ vt[k]
        ps = ss @ vt[k]
        q = [5, 25, 50, 75, 95]
        print(f"PC{k + 1} quantiles real {np.percentile(pr, q) * 1e4} | sim {np.percentile(ps, q) * 1e4} (x1e-4)")
    # residual after removing first 3 real PCs: small-scale structure
    basis = vt[:3]
    rr = centered - centered @ basis.T @ basis
    sr = (ss - rs.mean(axis=0)) - (ss - rs.mean(axis=0)) @ basis.T @ basis
    print("residual (beyond 3 PCs) std per channel ratio sim/real, median:", np.median(sr.std(axis=0) / rr.std(axis=0)).round(2))
    for subset in ("inert", "materials"):
        rm = real["label"] == "inert" if subset == "inert" else real["label"] != "inert"
        sm = sim["label"] == "inert" if subset == "inert" else sim["label"] != "inert"
        ri, si = rs[rm], ss[sm]
        print(f"[{subset}] kurtosis real {np.median(kurtosis(ri)):.1f} sim {np.median(kurtosis(si)):.1f}; "
              f"std ratio median {np.median(si.std(axis=0) / ri.std(axis=0)):.2f}; "
              f"IQR ratio median {np.median((np.percentile(si, 75, axis=0) - np.percentile(si, 25, axis=0)) / (np.percentile(ri, 75, axis=0) - np.percentile(ri, 25, axis=0))):.2f}; "
              f"classifier {domain_accuracy(ri, si):.3f}")
        for k in range(2):
            q = [5, 25, 50, 75, 95]
            print(f"   PC{k + 1} real {np.round(np.percentile(ri @ vt[k], q) * 1e4, 2)} sim {np.round(np.percentile(si @ vt[k], q) * 1e4, 2)}")
    # within-baseline wander
    for name, data in (("real", load_real(Path(real_path))), ("sim", load_sim(Path(sim_path)))):
        wander = np.median([np.std(b[:, ACTIVE] / b[:, ACTIVE].mean(axis=0), axis=0).mean() for b in data["baseline"]])
        rows = np.median([b.shape[0] for b in data["baseline"]]), np.median([s.shape[0] for s in data["sample"]])
        print(f"{name}: within-baseline relative std {wander:.2e}, rows {rows}")


if __name__ == "__main__":
    if sys.argv[1] == "--diagnose":
        diagnose(sys.argv[2], sys.argv[3])
    else:
        main()
