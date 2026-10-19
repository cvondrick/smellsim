"""Baseline resistance vs. recorded ambient humidity and temperature (within-session regression).

If the dominant response direction is water vapor, the per-channel slope of ln(R0) against
absolute humidity should match the vegetation direction, and its magnitude anchors each channel's
absolute water sensitivity.

Usage: uv run --with pyarrow --with numpy python -I scripts/nys_fit/ambient.py /tmp/nys_data data/nys_targets.json
"""

import json
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

DEAD = list(range(2, 32, 4))
ACTIVE = [c for c in range(32) if c not in DEAD]
VEGETATION = ["foliage", "shrub", "flower", "grass", "fruit"]


def saturation_ppm(temp_c: np.ndarray) -> np.ndarray:
    p_sat_hpa = 6.112 * np.exp(17.62 * temp_c / (243.12 + temp_c))
    return p_sat_hpa / 1013.25 * 1e6


def main() -> None:
    directory, targets_path = Path(sys.argv[1]), Path(sys.argv[2])
    columns = ["baseline_raw", "humidity", "temperature", "session", "pid"]
    data: dict[str, list] = {c: [] for c in columns}
    for path in sorted(directory.glob("*.parquet")):
        table = pq.read_table(path, columns=columns)
        for c in columns:
            data[c].extend(table.column(c).to_pylist())
    rh = np.asarray(data["humidity"], dtype=float)
    temp = np.asarray(data["temperature"], dtype=float)
    session = np.asarray(data["session"])
    water = rh / 100 * saturation_ppm(temp)
    log_r0 = np.log(np.array([np.asarray(b)[:, ACTIVE].mean(axis=0) for b in data["baseline_raw"]]))
    ok = np.isfinite(water) & np.isfinite(temp) & np.isfinite(log_r0).all(axis=1)
    print(f"captures {ok.sum()}, sessions {len(set(session[ok]))}")
    print(f"ambient water ppm p5/p50/p95: {np.percentile(water[ok], [5, 50, 95]).round(0)}, T p5/p95: {np.percentile(temp[ok], [5, 95]).round(1)}")

    def demean(x: np.ndarray) -> np.ndarray:
        out = x.astype(float).copy()
        for s in np.unique(session[ok]):
            mask = session[ok] == s
            out[mask] -= out[mask].mean(axis=0)
        return out

    y = demean(log_r0[ok])
    x = np.column_stack([demean(water[ok]), demean(temp[ok])])
    print(f"within-session std: water {x[:, 0].std():.0f} ppm, T {x[:, 1].std():.2f} C")
    coef, *_ = np.linalg.lstsq(x, y, rcond=None)
    residual = y - x @ coef
    r2 = 1 - residual.var(axis=0) / y.var(axis=0)
    water_slope = coef[0]  # d ln R / d ppm
    temp_slope = coef[1]  # d ln R / d C
    # standard errors (ignoring autocorrelation, so optimistic)
    cov = np.linalg.inv(x.T @ x)
    se = np.sqrt(np.outer(np.diag(cov), residual.var(axis=0)))
    np.set_printoptions(precision=2, suppress=True, linewidth=220)
    print("water slope x1e8 per ppm:", water_slope * 1e8)
    print("  t-stat:", (water_slope / se[0]).round(1))
    print("temp slope x1e4 per C:  ", temp_slope * 1e4)
    print("  t-stat:", (temp_slope / se[1]).round(1))
    print("R^2 per channel:", r2.round(2))

    targets = json.loads(targets_path.read_text())
    train = targets["splits"]["train"]
    inert = np.asarray(train["inert_mean_shift"])
    vegetation = np.mean([np.asarray(train["materials"][m]["mean_shift"]) - inert for m in VEGETATION], axis=0)

    def cos(a: np.ndarray, b: np.ndarray) -> float:
        return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))

    print(f"\ncosine(water slope, vegetation excess)   = {cos(water_slope, vegetation):.3f}")
    print(f"cosine(temp slope,  vegetation excess)   = {cos(temp_slope, vegetation):.3f}")
    print(f"cosine(water slope, inert offset)        = {cos(water_slope, inert):.3f}")
    print(f"cosine(temp slope,  inert offset)        = {cos(temp_slope, inert):.3f}")
    # implied humidity differences if the vegetation excess / inert offset are pure water
    scale_veg = vegetation @ water_slope / (water_slope @ water_slope)
    scale_inert = inert @ water_slope / (water_slope @ water_slope)
    print(f"implied water difference: vegetation {scale_veg:.0f} ppm, inert offset {scale_inert:.0f} ppm (snout minus side)")
    calibration_path = Path("src/chem/nysCalibration.json")
    if calibration_path.exists():
        calibration = json.loads(calibration_path.read_text())
        gain = calibration["gain"]
        fitted = np.array([gain * 10 ** ch["waterLog10K"] * 18.02 / 1.0 * 1e-6 * 41.4e-6 for ch in calibration["channels"] if ch["kind"] == "active"])
        print(f"fitted w (from material fit) / ambient slope, median ratio: {np.median(fitted / water_slope):.2f}; cosine {cos(fitted, water_slope):.3f}")
    out = {"water_slope_per_ppm": water_slope.tolist(), "temp_slope_per_C": temp_slope.tolist(), "water_tstat": (water_slope / se[0]).tolist(), "temp_tstat": (temp_slope / se[1]).tolist()}
    Path("data/nys_ambient_slopes.json").write_text(json.dumps(out, indent=1))
    print("wrote data/nys_ambient_slopes.json")


if __name__ == "__main__":
    main()
