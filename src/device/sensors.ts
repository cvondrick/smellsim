// Physics of the carbon-black/polymer chemiresistor array.
//
// 1. Partitioning: vapor j dissolves into polymer i with partition coefficient K_ij from an
//    LSER, corrected to the substrate temperature with a van 't Hoff term (sorption is
//    exothermic, so a warmer substrate absorbs less).
// 2. Swelling: the absorbed volume fraction phi_i = sum_j K_ij C_j V_j, where C_j is the gas
//    concentration (mol/m^3) and V_j the liquid molar volume.
// 3. Percolation: swelling dilutes the carbon black. With volume fraction v = v0 / (1 + phi) and
//    percolation threshold vc, resistance follows R ~ (v - vc)^(-t), t ~ 2 in 3D.
// 4. Kinetics: phi relaxes toward equilibrium with a polymer-specific time constant.
// 5. Readout: baseline drift (random walk), white noise, small substrate temperature coefficient.

import { AIR_MOLAR_DENSITY, COMPOUNDS, molarVolume } from '../chem/compounds';
import { POLYMERS } from '../chem/polymers';

const PERCOLATION_THRESHOLD = 0.16;
const PERCOLATION_EXPONENT = 2.0;
const GAS_CONSTANT = 8.314;
// LSERs overpredict water uptake in these composites (water clusters rather than swelling the
// carbon-black network uniformly). This damping is a tuning choice, not a fitted constant.
const WATER_LOG_K_CORRECTION = -0.7;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SensorArray {
  readonly count = POLYMERS.length;
  private readonly nCompounds = COMPOUNDS.length;
  private readonly logK298: Float64Array;
  private readonly enthalpy: Float64Array; // J/mol (negative = exothermic)
  private readonly molarVolumes: Float64Array;
  private partition: Float64Array;
  readonly phi: Float64Array;
  private readonly phiEq: Float64Array;
  private readonly drift: Float64Array;
  private readonly driftRate: Float64Array;
  readonly baseResistance: Float64Array;
  private readonly v0: Float64Array;
  private readonly random: () => number;
  substrateTempC = 30;
  noiseLevel = 1e-5;
  driftLevel = 3e-6;

  constructor(seed = 7) {
    this.random = mulberry32(seed);
    const n = this.count;
    const m = this.nCompounds;
    this.logK298 = new Float64Array(n * m);
    this.enthalpy = new Float64Array(m);
    this.molarVolumes = new Float64Array(m);
    this.partition = new Float64Array(n * m);
    this.phi = new Float64Array(n);
    this.phiEq = new Float64Array(n);
    this.drift = new Float64Array(n);
    this.driftRate = new Float64Array(n);
    this.baseResistance = new Float64Array(n);
    this.v0 = new Float64Array(n);
    COMPOUNDS.forEach((compound, j) => {
      this.molarVolumes[j] = molarVolume(compound);
      this.enthalpy[j] = compound.id === 'water' ? -44e3 : -(20e3 + 8e3 * compound.L);
    });
    POLYMERS.forEach((polymer, i) => {
      const [c, e, s, a, b, l] = polymer.lser;
      COMPOUNDS.forEach((compound, j) => {
        const correction = compound.id === 'water' ? WATER_LOG_K_CORRECTION : 0;
        this.logK298[i * m + j] = c + e * compound.E + s * compound.S + a * compound.A + b * compound.B + l * compound.L + correction;
      });
      // unit-to-unit manufacturing variation
      this.baseResistance[i] = polymer.baseResistance * (0.9 + 0.2 * this.random());
      this.v0[i] = PERCOLATION_THRESHOLD * (1 + polymer.percolationMargin * (0.9 + 0.2 * this.random()));
      this.driftRate[i] = (this.random() - 0.5) * 2e-6;
    });
    this.setSubstrateTemperature(30);
  }

  setSubstrateTemperature(tempC: number): void {
    this.substrateTempC = tempC;
    const inverseDelta = 1 / (273.15 + tempC) - 1 / 298.15;
    const m = this.nCompounds;
    for (let i = 0; i < this.count; i++) {
      for (let j = 0; j < m; j++) {
        const lnShift = (-this.enthalpy[j] / GAS_CONSTANT) * inverseDelta;
        this.partition[i * m + j] = Math.pow(10, this.logK298[i * m + j]) * Math.exp(lnShift);
      }
    }
  }

  /** Partition coefficient K (dimensionless) of compound j in sensor i at the substrate temperature. */
  partitionCoefficient(sensor: number, compound: number): number {
    return this.partition[sensor * this.nCompounds + compound];
  }

  /** Equilibrium swelling volume fraction for each sensor, given gas concentrations in ppm. */
  equilibrium(ppm: ArrayLike<number>, out: Float64Array = this.phiEq): Float64Array {
    const m = this.nCompounds;
    for (let i = 0; i < this.count; i++) {
      let phi = 0;
      for (let j = 0; j < m; j++) {
        const concentration = ppm[j];
        if (concentration <= 0) continue;
        const molPerM3 = concentration * 1e-6 * AIR_MOLAR_DENSITY;
        phi += this.partition[i * m + j] * molPerM3 * this.molarVolumes[j];
      }
      out[i] = phi;
    }
    return out;
  }

  /** Sensitivity of sensor i to compound j: d(dR/R)/d(ppm) near zero concentration. */
  sensitivity(sensor: number, compound: number): number {
    const m = this.nCompounds;
    const dPhi = this.partition[sensor * m + compound] * 1e-6 * AIR_MOLAR_DENSITY * this.molarVolumes[compound];
    const v0 = this.v0[sensor];
    return PERCOLATION_EXPONENT * dPhi * (v0 / (v0 - PERCOLATION_THRESHOLD));
  }

  private percolation(sensor: number, phi: number): number {
    const v0 = this.v0[sensor];
    const vc = PERCOLATION_THRESHOLD;
    const denominator = Math.max((v0 - vc) * 0.02, v0 / (1 + phi) - vc);
    return Math.pow((v0 - vc) / denominator, PERCOLATION_EXPONENT);
  }

  /** Initialize swelling to equilibrium with a gas composition (e.g. at power-on). */
  equilibrate(ppm: ArrayLike<number>): void {
    this.equilibrium(ppm);
    this.phi.set(this.phiEq);
  }

  step(dt: number, ppm: ArrayLike<number>): void {
    if (dt <= 0) return;
    this.equilibrium(ppm);
    for (let i = 0; i < this.count; i++) {
      const target = this.phiEq[i];
      const tau = POLYMERS[i].tau * (target < this.phi[i] ? 1.6 : 1);
      this.phi[i] += (target - this.phi[i]) * (1 - Math.exp(-dt / tau));
      this.drift[i] += this.driftRate[i] * dt + this.driftLevel * Math.sqrt(dt) * this.gaussian();
    }
  }

  private gaussian(): number {
    const u1 = Math.max(1e-12, this.random());
    const u2 = this.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Current resistances (ohms) including drift and readout noise. */
  read(out: Float64Array = new Float64Array(this.count)): Float64Array {
    const thermal = 1 + 0.002 * (this.substrateTempC - 30);
    for (let i = 0; i < this.count; i++) {
      const noise = 1 + this.noiseLevel * this.gaussian();
      out[i] = this.baseResistance[i] * thermal * this.percolation(i, this.phi[i]) * (1 + this.drift[i]) * noise;
    }
    return out;
  }
}
