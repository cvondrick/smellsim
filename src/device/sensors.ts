// Physics of the carbon-black/polymer chemiresistor array.
//
// 1. Partitioning: vapor j dissolves into polymer i with partition coefficient K_ij from an
//    LSER, corrected to the substrate temperature with a van 't Hoff term (sorption is
//    exothermic, so a warmer substrate absorbs less).
// 2. Swelling: the absorbed volume fraction phi_i = sum_j K_ij C_j V_j, where C_j is the gas
//    concentration (mol/m^3) and V_j the liquid molar volume.
// 3. Percolation: swelling dilutes the carbon black. With volume fraction v = v0 / (1 + phi) and
//    percolation threshold vc, resistance follows R ~ (v - vc)^(-t), t ~ 2 in 3D.
// 4. Kinetics: phi relaxes toward equilibrium with a channel-specific time constant.
// 5. Readout: gas temperature coefficient, baseline drift (random walk), white noise, optional
//    external offsets; non-sensing channels produce a two-level readout with shared spikes.
//
// Channel parameters come from a SensorProfile (see profiles.ts).

import { AIR_MOLAR_DENSITY, COMPOUNDS, WATER_INDEX, molarVolume } from '../chem/compounds';
import { getProfile, type SensorProfile } from './profiles';

const PERCOLATION_THRESHOLD = 0.16;
const PERCOLATION_EXPONENT = 2.0;
const GAS_CONSTANT = 8.314;
const REFERENCE_GAS_TEMP_C = 25;
// LSERs overpredict water uptake in these composites (water clusters rather than swelling the
// carbon-black network uniformly). Used only for channels without a measured water partition.
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

function lnShift(enthalpy: number, tempC: number): number {
  return (-enthalpy / GAS_CONSTANT) * (1 / (273.15 + tempC) - 1 / 298.15);
}

export class SensorArray {
  readonly profile: SensorProfile;
  readonly count: number;
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
  readonly active: boolean[];
  substrateTempC = 30;
  private episodeRows = 0;
  private episodeMagnitude = 0;

  constructor(profile: SensorProfile = getProfile(), seed = 7) {
    this.profile = profile;
    this.random = mulberry32(seed);
    const n = (this.count = profile.channels.length);
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
    this.active = profile.channels.map((channel) => channel.kind === 'active');
    COMPOUNDS.forEach((compound, j) => {
      this.molarVolumes[j] = molarVolume(compound);
      this.enthalpy[j] = compound.id === 'water' ? -44e3 : -(20e3 + 8e3 * compound.L);
    });
    const variation = profile.unitVariation;
    profile.channels.forEach((channel, i) => {
      const [c, e, s, a, b, l] = channel.lser;
      COMPOUNDS.forEach((compound, j) => {
        let logK = c + e * compound.E + s * compound.S + a * compound.A + b * compound.B + l * compound.L;
        if (j === WATER_INDEX) {
          // measured water partitions are defined at the 30 C substrate; store them at 298 K
          logK = channel.waterLog10K !== null ? channel.waterLog10K - lnShift(this.enthalpy[j], 30) / Math.LN10 : logK + WATER_LOG_K_CORRECTION;
        }
        this.logK298[i * m + j] = channel.kind === 'active' ? logK : -30;
      });
      this.baseResistance[i] = channel.baseResistance * (1 - variation + 2 * variation * this.random());
      this.v0[i] = PERCOLATION_THRESHOLD * (1 + channel.percolationMargin * (1 - variation + 2 * variation * this.random()));
      this.driftRate[i] = (this.random() - 0.5) * 2 * profile.driftRateScale;
    });
    this.setSubstrateTemperature(30);
  }

  setSubstrateTemperature(tempC: number): void {
    this.substrateTempC = tempC;
    const m = this.nCompounds;
    for (let i = 0; i < this.count; i++) {
      for (let j = 0; j < m; j++) {
        this.partition[i * m + j] = Math.pow(10, this.logK298[i * m + j]) * Math.exp(lnShift(this.enthalpy[j], tempC));
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
    const driftLevel = this.profile.driftLevel;
    for (let i = 0; i < this.count; i++) {
      const target = this.phiEq[i];
      const tau = this.profile.channels[i].tau * (target < this.phi[i] ? 1.6 : 1);
      this.phi[i] += (target - this.phi[i]) * (1 - Math.exp(-dt / tau));
      this.drift[i] += this.driftRate[i] * dt + driftLevel * Math.sqrt(dt) * this.gaussian();
    }
  }

  gaussian(): number {
    const u1 = Math.max(1e-12, this.random());
    const u2 = this.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  uniform(): number {
    return this.random();
  }

  /**
   * Current readings including temperature coefficient, drift, noise and optional
   * per-channel multiplicative offsets (e.g. inlet-path effects).
   */
  read(out: Float64Array = new Float64Array(this.count), gasTempC = REFERENCE_GAS_TEMP_C, offsets: ArrayLike<number> | null = null): Float64Array {
    const thermal = 1 + 0.002 * (this.substrateTempC - 30);
    const channels = this.profile.channels;
    const dead = this.profile.dead;
    // shared glitch episodes on the non-sensing channels
    if (dead) {
      if (this.episodeRows > 0) {
        this.episodeRows--;
      } else if (this.random() < dead.episodeStartProbability) {
        const sigma = Math.log(Math.max(1.01, dead.episodeP90 / dead.episodeMedian)) / 1.2816;
        const sign = this.random() < dead.episodeNegativeFraction ? -1 : 1;
        this.episodeMagnitude = sign * Math.min(0.9, dead.episodeMedian * Math.exp(sigma * this.gaussian()));
        this.episodeRows = Math.max(1, Math.round(-Math.log(Math.max(1e-9, this.random())) * dead.episodeMeanRows));
      }
      if (this.episodeRows === 0) this.episodeMagnitude = 0;
    }
    let deadIndex = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.active[i]) {
        if (dead) {
          const k = deadIndex++;
          const state = this.random() < dead.lowFraction[k] ? dead.lowRelative[k] : dead.highRelative[k];
          out[i] = this.baseResistance[i] * (1 + state + dead.jitter[k] * this.gaussian()) * (1 + this.episodeMagnitude * (0.9 + 0.2 * this.random()));
        } else {
          out[i] = this.baseResistance[i];
        }
        continue;
      }
      const temperature = 1 + channels[i].tempCoefficient * (gasTempC - REFERENCE_GAS_TEMP_C);
      const offset = offsets ? 1 + offsets[i] : 1;
      const noise = 1 + channels[i].noise * this.gaussian();
      out[i] = this.baseResistance[i] * thermal * temperature * this.percolation(i, this.phi[i]) * (1 + this.drift[i]) * offset * noise;
    }
    return out;
  }
}
