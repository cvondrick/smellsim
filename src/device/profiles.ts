// Sensor profiles: which physics each of the 32 channels follows.
//
// 'nys'        channels fitted to the Cyranose 320 unit in the New York Smells dataset
//              (scripts/nys_fit). 24 active chemiresistors with fitted LSER chemistry, measured
//              humidity and temperature sensitivities, 8 non-sensing positions with telegraph-like
//              readout, and a snout-vs-side inlet nuisance model. Readout in the dataset's units.
// 'literature' a plausible 32-polymer set from the carbon-black composite literature (ohms).

import calibration from '../chem/nysCalibration.json';
import { FAMILY_COLORS, POLYMERS, type PolymerFamily } from '../chem/polymers';

export type ProfileId = 'nys' | 'literature';

export interface ChannelSpec {
  label: string;
  detail: string;
  color: string;
  kind: 'active' | 'dead';
  lser: [number, number, number, number, number, number]; // c, e, s, a, b, l
  waterLog10K: number | null; // explicit water partition at 30 C (null: LSER with correction)
  tempCoefficient: number; // relative resistance change per C of chamber gas temperature
  tau: number; // sorption time constant (s)
  percolationMargin: number;
  baseResistance: number; // readout units at baseline
  noise: number; // relative white noise per reading
}

export interface DeadChannelModel {
  lowRelative: number[]; // two readout levels relative to the channel level
  highRelative: number[];
  lowFraction: number[];
  jitter: number[];
  episodeStartProbability: number; // per reading: start of a shared glitch episode
  episodeMeanRows: number;
  episodeNegativeFraction: number;
  episodeMedian: number; // relative magnitude
  episodeP90: number;
}

export interface HeavyTailedOffsets {
  mean: number[]; // per active channel
  cholesky: number[][]; // lower-triangular factor of the t scale matrix
  nu: number; // degrees of freedom
}

export interface WanderModel {
  loading: number[]; // per channel (0 for non-sensing)
  snoutFactor: number; // wander amplitude on the snout path relative to the side inlet
  tauSeconds: number;
  amplitudeLogMedian: number;
  amplitudeLogSd: number;
}

export interface NuisanceModel {
  empiricalVectors: number[][] | null; // preferred: real inert-capture offset vectors (bootstrap)
  heavyTailed: HeavyTailedOffsets | null; // fallback: multivariate t
  wander: WanderModel | null;
  pathWaterMeanPpm: number;
  pathWaterSdPpm: number;
  pathTempMeanC: number;
  pathTempSdC: number;
  residualMean: number[]; // per active channel
  residualFactors: number[][]; // factors x active channels
  residualDiag: number[];
}

export interface SensorProfile {
  id: ProfileId;
  name: string;
  description: string;
  units: string;
  channels: ChannelSpec[];
  dead: DeadChannelModel | null;
  nuisance: NuisanceModel | null;
  tubeMl: number;
  chamberMl: number;
  driftLevel: number; // random-walk drift (relative per sqrt(s))
  driftRateScale: number; // per-channel deterministic drift rate (relative per s), 0 = none
  unitVariation: number; // manufacturing spread applied at construction (0 for a measured unit)
  stepOffsets: boolean; // inlet offsets switch with the valve (true) or follow chamber mixing
}

const DEAD_COLOR = '#5b6573';

function cholesky(matrix: number[][], scale: number): number[][] {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i][j] * scale * scale;
      for (let k = 0; k < j; k++) sum -= lower[i][k] * lower[j][k];
      lower[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-30)) : sum / lower[j][j];
    }
  }
  return lower;
}

function literatureProfile(): SensorProfile {
  return {
    id: 'literature',
    name: 'Literature polymers',
    description: 'A plausible 32-polymer carbon-black composite array from the literature (not a real unit).',
    units: 'ohm',
    channels: POLYMERS.map((polymer) => ({
      label: polymer.abbr,
      detail: polymer.name,
      color: FAMILY_COLORS[polymer.family],
      kind: 'active' as const,
      lser: polymer.lser,
      waterLog10K: null,
      tempCoefficient: 0,
      tau: polymer.tau,
      percolationMargin: polymer.percolationMargin,
      baseResistance: polymer.baseResistance,
      noise: 1e-5,
    })),
    dead: null,
    nuisance: null,
    tubeMl: 0.4,
    chamberMl: 1.5,
    driftLevel: 3e-6,
    driftRateScale: 1e-6,
    unitVariation: 0.1,
    stepOffsets: false,
  };
}

interface CalibrationChannel {
  label: string;
  level: number;
  noise: number;
  kind: string;
  lser?: number[];
  waterLog10K?: number;
  tempCoefficient?: number;
  initPolymer?: string;
  family?: string;
}

function nysProfile(): SensorProfile {
  const channels = (calibration.channels as CalibrationChannel[]).map((channel): ChannelSpec => {
    if (channel.kind === 'active' && channel.lser) {
      return {
        label: channel.label,
        detail: `fitted channel (initialized from ${channel.initPolymer})`,
        color: FAMILY_COLORS[(channel.family as PolymerFamily) ?? 'dipolar'],
        kind: 'active',
        lser: channel.lser as ChannelSpec['lser'],
        waterLog10K: channel.waterLog10K ?? null,
        tempCoefficient: channel.tempCoefficient ?? 0,
        tau: 0.25,
        percolationMargin: 0.5,
        baseResistance: channel.level,
        noise: channel.noise,
      };
    }
    return {
      label: channel.label,
      detail: 'non-sensing position (telegraph readout)',
      color: DEAD_COLOR,
      kind: 'dead',
      lser: [0, 0, 0, 0, 0, 0],
      waterLog10K: null,
      tempCoefficient: 0,
      tau: 1,
      percolationMargin: 0.5,
      baseResistance: channel.level,
      noise: channel.noise,
    };
  });
  const dead = calibration.dead;
  const nuisance = calibration.nuisance;
  const heavy = calibration.nuisanceT;
  const wander = calibration.wander;
  const tuning = calibration.nuisanceTuning;
  const activeIndex = channels.flatMap((channel, i) => (channel.kind === 'active' ? [i] : []));
  for (const channel of channels) if (channel.kind === 'active') channel.noise *= tuning.noiseGain;
  const wanderLoading = new Array<number>(channels.length).fill(0);
  activeIndex.forEach((channel, k) => (wanderLoading[channel] = wander.loading[k]));
  return {
    id: 'nys',
    name: 'Fitted to New York Smells unit',
    description:
      'Channels fitted to the Cyranose 320 in the New York Smells dataset: 24 active sensors, 8 non-sensing positions, inlet humidity/temperature offsets.',
    units: 'raw',
    channels,
    dead: {
      lowRelative: dead.low_relative,
      highRelative: dead.high_relative,
      lowFraction: dead.low_fraction,
      jitter: dead.jitter_relative,
      episodeStartProbability: dead.episode_start_probability,
      episodeMeanRows: dead.episode_mean_rows,
      episodeNegativeFraction: dead.episode_negative_fraction,
      episodeMedian: dead.episode_median_abs,
      episodeP90: dead.episode_p90_abs,
    },
    nuisance: {
      empiricalVectors: calibration.nuisanceVectors,
      heavyTailed: { mean: heavy.mean, cholesky: cholesky(heavy.scale, heavy.residualScale), nu: heavy.nu },
      wander: {
        loading: wanderLoading,
        snoutFactor: tuning.wanderSnoutFactor,
        tauSeconds: wander.tauSeconds,
        amplitudeLogMedian: wander.amplitudeLogMedian + Math.log(tuning.wanderGain),
        amplitudeLogSd: wander.amplitudeLogSd,
      },
      pathWaterMeanPpm: nuisance.pathWaterMeanPpm,
      pathWaterSdPpm: nuisance.pathWaterSdPpm,
      pathTempMeanC: nuisance.pathTempMeanC,
      pathTempSdC: nuisance.pathTempSdC,
      residualMean: nuisance.residualMean,
      residualFactors: nuisance.residualFactors,
      residualDiag: nuisance.residualDiag,
    },
    tubeMl: 0.2,
    chamberMl: 0.4,
    // drift and response timing are already contained in the bootstrapped real offsets
    driftLevel: 1e-6,
    driftRateScale: 0,
    unitVariation: 0,
    stepOffsets: true,
  };
}

export const PROFILES: Record<ProfileId, () => SensorProfile> = {
  nys: nysProfile,
  literature: literatureProfile,
};

export const DEFAULT_PROFILE: ProfileId = 'nys';

export function getProfile(id: ProfileId = DEFAULT_PROFILE): SensorProfile {
  return PROFILES[id]();
}
