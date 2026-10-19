"""Fit the simulator's sensor channels to the New York Smells Cyranose unit.

Model of the relative sample shift (sample mean / baseline mean - 1) on the 24 active channels:

    shift = w * dH + tau * dT + GAIN * sum_j K_kj(theta_k) V_j C_j + residual

  * w_k, tau_k: water (per ppm) and temperature (per C) sensitivities. Anchored by the
    within-session regression of baseline resistance on recorded ambient humidity and
    temperature (ambient.py), which gives absolute scales independent of any chemistry guess.
  * K_kj: LSER partition coefficient of compound j in channel k (6 coefficients per channel),
    corrected to the 30 C substrate; V_j molar volume; C_j VOC concentration at the snout.
  * nuisance: random humidity and temperature differences between snout and side inlet, plus a
    low-rank residual, fitted to captures of inert objects (metals, glass, porcelain).
  * each material class gets a free VOC scale and humidity/temperature offsets, so the fit
    constrains per-channel response *patterns*.

The 8 non-sensing channels are modeled separately (see extract_targets.py).

Usage:
  uv run --with torch --with numpy python -I scripts/nys_fit/fit.py \
      data/nys_targets.json data/sim_chem.json data/nys_ambient_slopes.json src/chem/nysCalibration.json
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import torch

torch.set_default_dtype(torch.float64)

GAS_CONSTANT = 8.314
SUBSTRATE_K = 303.15
AIR = 41.4e-6  # mol/m^3 per ppm
GAIN = 6.0  # d(dR/R)/d(phi) at percolation margin 0.5
NEAR = 0.8  # near-field factor at contact (snout ~0.5 cm from the surface)
LITERATURE_WATER_LOGK_CORRECTION = -0.7
PRIOR_SD = torch.tensor([0.5, 0.3, 0.3, 0.3, 0.3, 0.15])  # c, e, s, a, b, l
MAX_EFFECTIVE_N = 150  # object-to-object variability caps the weight of large classes
WATER_PRIOR_SD = 0.3  # log-space deviation allowed from the ambient-regression water slope

MATERIAL_MAP = {
    "thermoplastic": ["plastic"], "thermoset": ["plastic"], "foam": ["plastic"],
    "paper": ["old_books"], "cardboard": ["cardboard"],
    "timber": ["pine_wood"], "tree bark": ["pine_wood"],
    "foliage": ["houseplant"], "shrub": ["houseplant"], "ivy": ["houseplant"],
    "flower": ["roses"], "grass": ["grass"], "soil": ["moss"],
    "elastomer": ["rubber_mat"], "leather": ["leather"],
    "polyester": ["polyester"], "nylon": ["polyester"], "cotton": ["polyester"], "carpet": ["polyester"],
    "fruit": ["orange", "banana"], "food-other": ["bread"],
    "cement": ["brick"], "concrete": ["brick"], "granite": ["brick"], "marble": ["brick"],
}
VEGETATION = ["foliage", "shrub", "flower", "grass", "fruit"]


def tensor(x) -> torch.Tensor:
    return torch.as_tensor(np.asarray(x, dtype=np.float64))


class Chemistry:
    def __init__(self, chem: dict) -> None:
        compounds = chem["compounds"]
        self.ids = [c["id"] for c in compounds]
        self.water = self.ids.index("water")
        self.descriptors = tensor([[c["E"], c["S"], c["A"], c["B"], c["L"]] for c in compounds])
        self.molar_volume = tensor([c["molarVolume"] for c in compounds])
        enthalpy = tensor([c["enthalpy"] for c in compounds])
        self.ln_temperature_shift = -enthalpy / GAS_CONSTANT * (1 / SUBSTRATE_K - 1 / 298.15)
        self.polymers = chem["polymers"]
        self.sources = {s["id"]: s for s in chem["sources"]}

    def log10_k(self, lser: torch.Tensor) -> torch.Tensor:
        """(channels, compounds) log10 partition coefficients at the substrate temperature."""
        base = lser[:, :1] + lser[:, 1:] @ self.descriptors.T
        return base + self.ln_temperature_shift[None, :] / math.log(10)

    def voc_response(self, lser: torch.Tensor, ppm: torch.Tensor) -> torch.Tensor:
        """Linearized relative response of each channel to a VOC mixture (water excluded)."""
        k = torch.pow(10.0, self.log10_k(lser))
        weights = (self.molar_volume * AIR * ppm).clone()
        weights[self.water] = 0.0
        return GAIN * k @ weights

    def water_sensitivity_literature(self, lser: torch.Tensor) -> torch.Tensor:
        log_k = self.log10_k(lser)[:, self.water] + LITERATURE_WATER_LOGK_CORRECTION
        return GAIN * torch.pow(10.0, log_k) * self.molar_volume[self.water] * AIR

    def material_voc(self, material: str) -> torch.Tensor:
        ppm = torch.zeros(len(self.ids))
        sources = MATERIAL_MAP[material]
        for source_id in sources:
            for compound_id, value in self.sources[source_id]["headspace"].items():
                ppm[self.ids.index(compound_id)] += NEAR * value / len(sources)
        return ppm


def initial_assignment(chemistry: Chemistry, water_slope: np.ndarray) -> list[int]:
    """Match literature polymers to real channels by water-sensitivity rank."""
    lser_all = tensor([p["lser"] for p in chemistry.polymers])
    water = chemistry.water_sensitivity_literature(lser_all).numpy()
    candidates = np.argsort(-water)[: len(water_slope)]  # the 24 most water-sensitive polymers
    channel_order = np.argsort(-water_slope)
    assignment = [0] * len(water_slope)
    for rank, channel in enumerate(channel_order):
        assignment[channel] = int(candidates[rank])
    return assignment


def fit(targets: dict, chemistry: Chemistry, ambient: dict, assignment: list[int], mode: str, steps: int) -> dict:
    """mode: 'literature' (all channel physics from literature), 'ambient' (measured water and
    temperature sensitivities, literature VOC chemistry) or 'fitted' (everything fitted)."""
    train = targets["splits"]["train"]
    inert_mean = tensor(train["inert_mean_shift"])
    inert_cov = tensor(train["inert_cov_shift"])
    inert_n = train["inert_n"]
    precision = torch.linalg.inv(inert_cov)
    materials = [m for m in train["materials"] if m in MATERIAL_MAP]
    real = torch.stack([tensor(train["materials"][m]["mean_shift"]) for m in materials])
    counts = tensor([min(train["materials"][m]["n"], MAX_EFFECTIVE_N) for m in materials])
    voc_ppm = torch.stack([chemistry.material_voc(m) for m in materials])
    channels = len(inert_mean)

    lser_init = tensor([chemistry.polymers[i]["lser"] for i in assignment])
    if mode == "literature":
        log_w_init = torch.log(chemistry.water_sensitivity_literature(lser_init))
        tau = torch.full((channels,), 0.0)
    else:
        log_w_init = torch.log(torch.clamp(tensor(ambient["water_slope_per_ppm"]), min=1e-8))
        tau = tensor(ambient["temp_slope_per_C"])
    params = {
        "lser": lser_init.clone().requires_grad_(mode == "fitted"),
        "log_w": log_w_init.clone().requires_grad_(mode == "fitted"),
        "log10_alpha": torch.zeros(len(materials), requires_grad=True),
        "water_h": torch.zeros(len(materials), requires_grad=True),  # material humidity offset, units of 100 ppm
        "temp_m": torch.zeros(len(materials), requires_grad=True),  # material temperature offset, C
        "path_water_h": torch.zeros(1, requires_grad=True),
        "log_path_water_sd_h": torch.zeros(1, requires_grad=True),
        "path_temp": torch.zeros(1, requires_grad=True),
        "log_path_temp_sd": torch.tensor([-1.0], requires_grad=True),
        "residual_mean_e5": torch.zeros(channels, requires_grad=True),
        "factors_e4": (0.1 * torch.randn(channels, 2, generator=torch.Generator().manual_seed(0))).requires_grad_(True),
        "log_diag": torch.log(torch.diag(inert_cov) * 0.3).clone().requires_grad_(True),
    }
    optimizer = torch.optim.Adam([p for p in params.values() if p.requires_grad], lr=0.02)

    def model_terms():
        w = torch.exp(params["log_w"])
        inert_model = w * 100 * params["path_water_h"] + tau * params["path_temp"] + 1e-5 * params["residual_mean_e5"]
        factors = 1e-4 * params["factors_e4"]
        cov_model = (
            (100 * torch.exp(params["log_path_water_sd_h"])) ** 2 * torch.outer(w, w)
            + torch.exp(params["log_path_temp_sd"]) ** 2 * torch.outer(tau, tau)
            + factors @ factors.T
            + torch.diag(torch.exp(params["log_diag"]))
        )
        voc = torch.stack([chemistry.voc_response(params["lser"], voc_ppm[i]) for i in range(len(materials))])
        alpha = torch.pow(10.0, params["log10_alpha"])[:, None]
        water = 100 * params["water_h"][:, None]
        temp = params["temp_m"][:, None]
        predicted = inert_model[None, :] + alpha * voc + water * w[None, :] + temp * tau[None, :]
        return predicted, inert_model, cov_model, w, voc, alpha, water, temp

    def loss_fn():
        predicted, inert_model, cov_model, _, _, _, _, _ = model_terms()
        residual = real - predicted
        material_term = (counts * torch.einsum("mi,ij,mj->m", residual, precision, residual)).sum()
        inert_residual = inert_mean - inert_model
        inert_term = inert_n * inert_residual @ precision @ inert_residual
        chol = torch.linalg.cholesky(cov_model)
        cov_term = inert_n * (torch.trace(torch.cholesky_solve(inert_cov, chol)) + 2 * torch.log(torch.diagonal(chol)).sum())
        prior = (params["log10_alpha"] ** 2).sum()
        prior = prior + (params["water_h"] ** 2).sum() / 10.0**2  # +-1000 ppm
        prior = prior + (params["temp_m"] ** 2).sum() / 1.0**2
        prior = prior + (params["residual_mean_e5"] ** 2).sum()
        prior = prior + (params["path_water_h"] ** 2).sum() / 10.0**2 + (params["path_temp"] ** 2).sum()
        if mode == "fitted":
            prior = prior + (((params["lser"] - lser_init) / PRIOR_SD) ** 2).sum()
            prior = prior + ((params["log_w"] - log_w_init) ** 2).sum() / WATER_PRIOR_SD**2
        return 0.5 * (material_term + inert_term + cov_term + prior), material_term

    for step in range(steps):
        optimizer.zero_grad()
        loss, material_term = loss_fn()
        loss.backward()
        optimizer.step()
        if step % 2000 == 0 or step == steps - 1:
            print(f"  step {step:5d} loss {loss.item():12.2f} material term {material_term.item():10.2f}")
    with torch.no_grad():
        predicted, inert_model, cov_model, w, voc, alpha, water, temp = model_terms()
    return {
        "params": {k: v.detach().clone() for k, v in params.items()},
        "materials": materials,
        "w": w,
        "tau": tau,
        "voc": voc,
        "alpha": alpha.squeeze(1),
        "water": water.squeeze(1),
        "temp": temp.squeeze(1),
        "inert_model": inert_model,
    }


def evaluate(targets: dict, result: dict, split: str) -> dict:
    data = targets["splits"][split]
    precision = torch.linalg.inv(tensor(targets["splits"]["train"]["inert_cov_shift"]))
    inert_real = tensor(data["inert_mean_shift"])
    rows = []
    num = 0.0
    den = 0.0
    for index, material in enumerate(result["materials"]):
        if material not in data["materials"]:
            continue
        real = tensor(data["materials"][material]["mean_shift"])
        n = min(data["materials"][material]["n"], MAX_EFFECTIVE_N)
        excess_pred = result["alpha"][index] * result["voc"][index] + result["water"][index] * result["w"] + result["temp"][index] * result["tau"]
        predicted = result["inert_model"] + excess_pred
        excess_real = real - inert_real
        cosine = float(excess_real @ excess_pred / (excess_real.norm() * excess_pred.norm() + 1e-15))
        err = real - predicted
        num += n * float(err @ precision @ err)
        den += n * float(excess_real @ precision @ excess_real)
        rows.append((material, data["materials"][material]["n"], cosine, float(excess_pred.norm() / (excess_real.norm() + 1e-15))))
    return {"rows": rows, "explained": 1 - num / max(den, 1e-12)}


def main() -> None:
    targets = json.loads(Path(sys.argv[1]).read_text())
    chemistry = Chemistry(json.loads(Path(sys.argv[2]).read_text()))
    ambient = json.loads(Path(sys.argv[3]).read_text())
    out = Path(sys.argv[4])
    water_slope = np.asarray(ambient["water_slope_per_ppm"])
    assignment = initial_assignment(chemistry, water_slope)
    print("initial polymer per active channel:", [chemistry.polymers[i]["abbr"] for i in assignment])

    results = {}
    for mode, steps in (("literature", 3000), ("ambient", 4000), ("fitted", 8000)):
        print(f"\n{mode}:")
        results[mode] = fit(targets, chemistry, ambient, assignment, mode, steps)

    report = {}
    for mode, result in results.items():
        for split in ("train", "test"):
            ev = evaluate(targets, result, split)
            report[f"{mode}_{split}_explained"] = ev["explained"]
            print(f"\n{mode} / {split}: explained material excess = {ev['explained']:.3f}")
            for material, n, cosine, ratio in ev["rows"]:
                print(f"   {material:14s} n={n:4d} cos={cosine:6.3f} |pred|/|real|={ratio:6.2f}")

    fitted = results["fitted"]
    params = fitted["params"]
    w = fitted["w"].numpy()
    print("\nfitted w / ambient slope (median):", float(np.median(w / np.maximum(water_slope, 1e-12))))
    lser = params["lser"].numpy()
    water_log_k = np.log10(w / (GAIN * chemistry.molar_volume[chemistry.water].item() * AIR))
    active = targets["active_channels"]
    channels = []
    for channel in range(32):
        entry = {"index": channel, "label": f"S{channel + 1}", "level": targets["level"][channel], "noise": targets["noise_relative"][channel]}
        if channel in active:
            k = active.index(channel)
            entry.update({
                "kind": "active",
                "lser": [round(float(v), 4) for v in lser[k]],
                "waterLog10K": round(float(water_log_k[k]), 4),
                "tempCoefficient": float(fitted["tau"][k]),
                "initPolymer": chemistry.polymers[assignment[k]]["abbr"],
                "family": chemistry.polymers[assignment[k]]["family"],
            })
        else:
            entry["kind"] = "dead"
        channels.append(entry)
    calibration = {
        "description": "Sensor channels fitted to the Cyranose 320 unit used in New York Smells.",
        "source": targets["source"],
        "gain": GAIN,
        "channels": channels,
        "dead": targets["dead_model"],
        "nuisance": {
            "pathWaterMeanPpm": float(100 * params["path_water_h"].item()),
            "pathWaterSdPpm": float(100 * math.exp(params["log_path_water_sd_h"].item())),
            "pathTempMeanC": float(params["path_temp"].item()),
            "pathTempSdC": float(math.exp(params["log_path_temp_sd"].item())),
            "residualMean": [float(v) for v in (1e-5 * params["residual_mean_e5"]).numpy()],
            "residualFactors": (1e-4 * params["factors_e4"]).numpy().T.tolist(),
            "residualDiag": [float(v) for v in torch.exp(params["log_diag"]).numpy()],
        },
        # heavy-tailed inlet offsets (multivariate t on inert captures) and common-mode slow wander;
        # the simulator samples these instead of the Gaussian decomposition above
        "nuisanceT": {
            "mean": targets["splits"]["train"]["inert_t"]["mean"],
            "scale": targets["splits"]["train"]["inert_t"]["scale"],
            "nu": targets["splits"]["train"]["inert_t"]["nu"],
            "residualScale": 1.0,
        },
        "nuisanceVectors": targets["splits"]["train"]["inert_vectors"],
        # tuned by grid search so simulated within-capture statistics match the real ones
        # (scripts/nys_fit/within_stats.py; baseline/sample spread and peak-minus-mean)
        "nuisanceTuning": {"wanderSnoutFactor": 0.45, "wanderGain": 1.35, "noiseGain": 0.9},
        "wander": {
            "loading": targets["wander"]["loading"],
            "tauSeconds": float(-(1 / 1.6) / math.log(targets["wander"]["lag1"])),
            "amplitudeLogMedian": targets["wander"]["amplitude_log_median"],
            "amplitudeLogSd": targets["wander"]["amplitude_log_sd"],
        },
        "materials": {
            material: {
                "simSources": MATERIAL_MAP[material],
                "vocScale": float(fitted["alpha"][i]),
                "waterPpm": float(fitted["water"][i]),
                "tempC": float(fitted["temp"][i]),
            }
            for i, material in enumerate(fitted["materials"])
        },
        "metrics": report,
    }
    out.write_text(json.dumps(calibration, indent=1))
    print(f"\nwrote {out}")
    print("nuisance:", {k: round(v, 3) for k, v in calibration["nuisance"].items() if not isinstance(v, list)})
    print("materials (vocScale, water ppm, temp C):", {m: (round(v["vocScale"], 3), round(v["waterPpm"]), round(v["tempC"], 2)) for m, v in calibration["materials"].items()})


if __name__ == "__main__":
    main()
