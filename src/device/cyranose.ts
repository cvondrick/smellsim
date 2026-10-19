// Cyranose 320 style handheld e-nose: pump, two inlets, sensor chamber and measurement cycle.
//
// Air reaches the 32-sensor chamber through one of two paths: the snout (sample inlet at the
// tip) or the side purge/baseline inlet that draws ambient air near the instrument body. A
// measurement records a baseline through the side inlet, then draws the sample through the
// snout, then purges. Tubing and chamber are modeled as two well-mixed volumes in series, so
// the response lags and smooths the concentration at the snout tip.

import { COMPOUNDS, WATER_INDEX } from '../chem/compounds';
import { cosineSimilarity, smellprint } from './analysis';
import { getProfile, type ProfileId } from './profiles';
import { SensorArray } from './sensors';

export type PhaseKind = 'baseline' | 'sample' | 'idle' | 'purge';

export interface Phase {
  kind: PhaseKind;
  label: string;
  duration: number; // s
  flow: number; // mL/min
}

export interface Method {
  name: string;
  phases: Phase[];
  substrateTempC: number;
  sampleRateHz: number;
  intakeFilter: boolean; // carbon filter on the purge inlet
}

export const METHODS: Method[] = [
  {
    name: 'Quick sniff',
    phases: [
      { kind: 'baseline', label: 'Baseline purge', duration: 6, flow: 120 },
      { kind: 'sample', label: 'Sample draw', duration: 8, flow: 120 },
      { kind: 'purge', label: 'Air intake purge', duration: 12, flow: 180 },
    ],
    substrateTempC: 30,
    sampleRateHz: 2,
    intakeFilter: false,
  },
  {
    name: 'Standard cycle',
    phases: [
      { kind: 'baseline', label: 'Baseline purge', duration: 10, flow: 120 },
      { kind: 'sample', label: 'Sample draw', duration: 20, flow: 120 },
      { kind: 'idle', label: 'Snout removal', duration: 3, flow: 0 },
      { kind: 'purge', label: 'Air intake purge', duration: 30, flow: 180 },
    ],
    substrateTempC: 30,
    sampleRateHz: 2,
    intakeFilter: false,
  },
  {
    name: 'Two-position 10/10/10',
    phases: [
      { kind: 'baseline', label: 'Baseline (side inlet)', duration: 10, flow: 120 },
      { kind: 'sample', label: 'Sample 1 (snout)', duration: 10, flow: 120 },
      { kind: 'idle', label: 'Reposition', duration: 2, flow: 0 },
      { kind: 'sample', label: 'Sample 2 (snout)', duration: 10, flow: 120 },
      { kind: 'purge', label: 'Purge', duration: 15, flow: 180 },
    ],
    substrateTempC: 30,
    sampleRateHz: 1.4,
    intakeFilter: false,
  },
];

const HISTORY_SECONDS = 120;
// nominal rows used to remove readout noise already contained in the fitted residual variance
const NOMINAL_BASELINE_ROWS = 18;
const NOMINAL_SAMPLE_ROWS = 16;

export interface GroundTruth {
  nearestSourceId: string;
  nearestSourceName: string;
  distance: number; // snout tip to source surface (m)
  topCompounds: { id: string; ppm: number }[];
  rh: number;
  tempC: number;
}

export interface Measurement {
  id: number;
  label: string;
  color: string;
  simTime: number;
  method: string;
  baseline: Float64Array[];
  sample: Float64Array[];
  times: number[];
  phases: PhaseKind[];
  smellprint: Float64Array;
  truth: GroundTruth;
  match: { label: string; similarity: number } | null;
}

export interface InletReading {
  ppm: Float32Array; // compound ppm (water included)
  tempC: number;
}

export type DeviceMode = 'idle' | 'cycle' | 'live';

export class Cyranose {
  sensors = new SensorArray(getProfile());
  method: Method = METHODS[0];
  mode: DeviceMode = 'idle';
  phaseIndex = 0;
  phaseTime = 0;
  readonly tube = new Float64Array(COMPOUNDS.length);
  readonly chamber = new Float64Array(COMPOUNDS.length);
  // gas temperature and the fraction of chamber air that came through the snout
  private tubeTemp = 25;
  private chamberTemp = 25;
  private tubeSnout = 0;
  private chamberSnout = 0;
  // inlet-path nuisance for the current measurement (profile-dependent)
  private pathWaterPpm = 0;
  private pathTempC = 0;
  private pathResidual = new Float64Array(32);
  private offsets = new Float64Array(32);
  // common-mode slow wander (sub-capture humidity/temperature fluctuations)
  private wanderState = 0;
  private wanderAmplitude = 0;
  private wanderRedrawIn = 0;
  private initialized = false;
  private sampleClock = 0;
  private lastTime = -1;
  resistance = new Float64Array(32);
  // strip chart history
  historyTimes: number[] = [];
  historyValues: Float64Array[] = []; // relative response vs reference
  historyPhases: (PhaseKind | 'live' | 'idle')[] = [];
  reference = new Float64Array(32);
  private hasReference = false;
  // current measurement
  private recBaseline: Float64Array[] = [];
  private recSample: Float64Array[] = [];
  private recTimes: number[] = [];
  private recPhases: PhaseKind[] = [];
  private pendingLabel = '';
  private pendingColor = '#ffffff';
  measurements: Measurement[] = [];
  private nextId = 1;
  lastTruth: GroundTruth | null = null;
  onMeasurement: ((measurement: Measurement) => void) | null = null;
  onPhaseChange: ((phase: Phase | null) => void) | null = null;

  setMethod(method: Method): void {
    this.method = method;
    this.sensors.setSubstrateTemperature(method.substrateTempC);
  }

  /** Swap the sensor model. Clears history and captures, since channels change meaning. */
  setProfile(id: ProfileId): void {
    this.sensors = new SensorArray(getProfile(id));
    this.sensors.setSubstrateTemperature(this.method.substrateTempC);
    const count = this.sensors.count;
    this.resistance = new Float64Array(count);
    this.reference = new Float64Array(count);
    this.pathResidual = new Float64Array(count);
    this.offsets = new Float64Array(count);
    this.wanderState = 0;
    this.wanderRedrawIn = 0;
    this.historyTimes = [];
    this.historyValues = [];
    this.historyPhases = [];
    this.measurements = [];
    this.mode = 'idle';
    this.initialized = false;
    this.hasReference = false;
  }

  /** How much of the chamber air came through the snout, for nuisance effects. */
  private snoutWeight(): number {
    if (this.sensors.profile.stepOffsets) return this.pneumatics.inlet === 'snout' ? 1 : 0;
    return this.chamberSnout;
  }

  /** Chi-square sample with nu degrees of freedom (Marsaglia-Tsang gamma). */
  private chiSquare(nu: number): number {
    const shape = nu / 2;
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.sensors.gaussian();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.sensors.uniform();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return 2 * d * v;
    }
  }

  private redrawWander(): void {
    const wander = this.sensors.profile.nuisance?.wander;
    if (!wander) return;
    this.wanderAmplitude = Math.exp(wander.amplitudeLogMedian + wander.amplitudeLogSd * this.sensors.gaussian());
    this.wanderRedrawIn = 30;
  }

  /** Draw the snout-vs-side inlet offsets for a new measurement. */
  private drawPathNuisance(): void {
    const nuisance = this.sensors.profile.nuisance;
    this.pathResidual.fill(0);
    if (!nuisance) {
      this.pathWaterPpm = 0;
      this.pathTempC = 0;
      return;
    }
    const gaussian = () => this.sensors.gaussian();
    const channels = this.sensors.profile.channels;
    this.redrawWander();
    if (nuisance.empiricalVectors && nuisance.empiricalVectors.length > 0) {
      // bootstrap a real inert-capture offset vector: exact joint distribution, skew and tails
      const vectors = nuisance.empiricalVectors;
      const offset = vectors[Math.floor(this.sensors.uniform() * vectors.length)];
      let k = 0;
      channels.forEach((channel, i) => {
        if (channel.kind === 'active') this.pathResidual[i] = offset[k++];
      });
      this.pathWaterPpm = 0;
      this.pathTempC = 0;
      return;
    }
    if (nuisance.heavyTailed) {
      // multivariate t: mean + L z * sqrt(nu / chi2_nu)
      const { mean, cholesky, nu } = nuisance.heavyTailed;
      const z = mean.map(() => gaussian());
      const mix = Math.sqrt(nu / this.chiSquare(nu));
      let k = 0;
      channels.forEach((channel, i) => {
        if (channel.kind !== 'active') return;
        let value = 0;
        for (let m = 0; m <= k; m++) value += cholesky[k][m] * z[m];
        this.pathResidual[i] = mean[k] + value * mix;
        k++;
      });
      this.pathWaterPpm = 0;
      this.pathTempC = 0;
      return;
    }
    this.pathWaterPpm = nuisance.pathWaterMeanPpm + nuisance.pathWaterSdPpm * gaussian();
    this.pathTempC = nuisance.pathTempMeanC + nuisance.pathTempSdC * gaussian();
    const latent = nuisance.residualFactors.map(() => gaussian());
    let k = 0;
    channels.forEach((channel, i) => {
      if (channel.kind !== 'active') return;
      let value = nuisance.residualMean[k];
      nuisance.residualFactors.forEach((factor, f) => (value += factor[k] * latent[f]));
      const readoutVariance = channel.noise ** 2 * (1 / NOMINAL_BASELINE_ROWS + 1 / NOMINAL_SAMPLE_ROWS);
      const variance = Math.max(0.1 * nuisance.residualDiag[k], nuisance.residualDiag[k] - readoutVariance);
      value += Math.sqrt(variance) * gaussian();
      this.pathResidual[i] = value;
      k++;
    });
  }

  get currentPhase(): Phase | null {
    return this.mode === 'cycle' ? this.method.phases[this.phaseIndex] ?? null : null;
  }

  get cycleDuration(): number {
    return this.method.phases.reduce((sum, phase) => sum + phase.duration, 0);
  }

  get cycleElapsed(): number {
    let elapsed = this.phaseTime;
    for (let p = 0; p < this.phaseIndex; p++) elapsed += this.method.phases[p].duration;
    return elapsed;
  }

  /** Which inlet feeds the chamber right now, and at what flow (mL/min). */
  get pneumatics(): { inlet: 'snout' | 'side' | 'none'; flow: number } {
    if (this.mode === 'live') return { inlet: 'snout', flow: 120 };
    const phase = this.currentPhase;
    if (!phase) return { inlet: 'side', flow: 50 }; // idle: gentle purge keeps sensors on ambient air
    if (phase.kind === 'sample') return { inlet: 'snout', flow: phase.flow };
    if (phase.kind === 'idle') return { inlet: 'none', flow: 0 };
    return { inlet: 'side', flow: phase.flow };
  }

  startCycle(label: string, color: string): void {
    if (this.mode === 'cycle') return;
    this.mode = 'cycle';
    this.phaseIndex = 0;
    this.phaseTime = 0;
    this.recBaseline = [];
    this.recSample = [];
    this.recTimes = [];
    this.recPhases = [];
    this.pendingLabel = label;
    this.pendingColor = color;
    this.drawPathNuisance();
    this.onPhaseChange?.(this.currentPhase);
  }

  abort(): void {
    this.mode = 'idle';
    this.onPhaseChange?.(null);
  }

  toggleLive(): void {
    if (this.mode === 'cycle') return;
    this.mode = this.mode === 'live' ? 'idle' : 'live';
    if (this.mode === 'live') this.drawPathNuisance();
    this.zeroReference();
  }

  /** The raw rows recorded so far in the running measurement (baseline then sample). */
  currentRows(): { rows: Float64Array[]; phases: PhaseKind[]; baselineMean: Float64Array | null } {
    let baselineMean: Float64Array | null = null;
    if (this.recBaseline.length > 0) {
      baselineMean = new Float64Array(this.sensors.count);
      for (const row of this.recBaseline) for (let i = 0; i < row.length; i++) baselineMean[i] += row[i] / this.recBaseline.length;
    }
    return { rows: [...this.recBaseline, ...this.recSample], phases: [...this.recPhases], baselineMean };
  }

  /** Make the current resistances the zero of the strip chart. */
  zeroReference(): void {
    this.reference.set(this.resistance);
    this.hasReference = true;
  }

  /** Advance the device by dt seconds of simulated time with the air at both inlets. */
  advance(simTime: number, snout: InletReading, side: InletReading, truth: GroundTruth): void {
    if (!this.initialized) {
      for (let j = 0; j < this.chamber.length; j++) {
        this.chamber[j] = side.ppm[j];
        this.tube[j] = side.ppm[j];
      }
      this.tubeTemp = this.chamberTemp = side.tempC;
      this.tubeSnout = this.chamberSnout = 0;
      this.sensors.equilibrate(this.chamber);
      this.sensors.read(this.resistance, this.chamberTemp);
      this.zeroReference();
      this.initialized = true;
      this.lastTime = simTime;
      return;
    }
    let dt = simTime - this.lastTime;
    this.lastTime = simTime;
    if (dt <= 0) return;
    if (dt > 5) dt = 5; // large time skips: treat as a short gap
    this.lastTruth = truth;

    const { inlet, flow } = this.pneumatics;
    const chamberFlow = flow / 60; // mL/s
    if (inlet !== 'none' && chamberFlow > 0) {
      const throughSnout = inlet === 'snout';
      const source = throughSnout ? snout.ppm : side.ppm;
      const filter = inlet === 'side' && this.method.intakeFilter;
      const profile = this.sensors.profile;
      const tubeBlend = 1 - Math.exp((-dt * chamberFlow) / profile.tubeMl);
      const chamberBlend = 1 - Math.exp((-dt * chamberFlow) / profile.chamberMl);
      for (let j = 0; j < this.chamber.length; j++) {
        let incoming = filter && j !== WATER_INDEX ? source[j] * 0.02 : source[j];
        if (throughSnout && j === WATER_INDEX) incoming = Math.max(0, incoming + this.pathWaterPpm);
        this.tube[j] += (incoming - this.tube[j]) * tubeBlend;
        this.chamber[j] += (this.tube[j] - this.chamber[j]) * chamberBlend;
      }
      const incomingTemp = throughSnout ? snout.tempC + this.pathTempC : side.tempC;
      this.tubeTemp += (incomingTemp - this.tubeTemp) * tubeBlend;
      this.chamberTemp += (this.tubeTemp - this.chamberTemp) * chamberBlend;
      this.tubeSnout += ((throughSnout ? 1 : 0) - this.tubeSnout) * tubeBlend;
      this.chamberSnout += (this.tubeSnout - this.chamberSnout) * chamberBlend;
    }
    this.sensors.step(dt, this.chamber);
    const wander = this.sensors.profile.nuisance?.wander;
    if (wander) {
      this.wanderRedrawIn -= dt;
      if (this.wanderRedrawIn <= 0 && this.mode !== 'cycle') this.redrawWander();
      const keep = Math.exp(-dt / wander.tauSeconds);
      this.wanderState = this.wanderState * keep + this.wanderAmplitude * Math.sqrt(1 - keep * keep) * this.sensors.gaussian();
    }

    this.sampleClock += dt;
    const period = 1 / this.method.sampleRateHz;
    while (this.sampleClock >= period) {
      this.sampleClock -= period;
      this.recordSample(simTime);
    }

    if (this.mode === 'cycle') {
      this.phaseTime += dt;
      const phase = this.method.phases[this.phaseIndex];
      if (this.phaseTime >= phase.duration) {
        if (phase.kind === 'baseline') {
          // The strip chart is referenced to the end of the baseline, like the instrument display.
          this.zeroReference();
        }
        this.phaseTime = 0;
        this.phaseIndex++;
        if (this.phaseIndex >= this.method.phases.length) {
          this.finishCycle(simTime);
        } else {
          this.onPhaseChange?.(this.currentPhase);
        }
      }
    }
  }

  private recordSample(simTime: number): void {
    const wanderModel = this.sensors.profile.nuisance?.wander;
    const loading = wanderModel?.loading;
    const snoutWeight = this.snoutWeight();
    const wanderWeight = wanderModel ? 1 - snoutWeight * (1 - wanderModel.snoutFactor) : 0;
    for (let i = 0; i < this.offsets.length; i++) {
      // slow wander comes with the ambient air at the side inlet; snout air at a surface is steadier
      this.offsets[i] = this.pathResidual[i] * snoutWeight + (loading ? loading[i] * this.wanderState * wanderWeight : 0);
    }
    const row = this.sensors.read(new Float64Array(this.sensors.count), this.chamberTemp, this.offsets);
    this.resistance.set(row);
    if (!this.hasReference) this.zeroReference();
    const relative = new Float64Array(row.length);
    for (let i = 0; i < row.length; i++) relative[i] = (row[i] - this.reference[i]) / this.reference[i];
    this.historyTimes.push(simTime);
    this.historyValues.push(relative);
    const phase = this.currentPhase;
    this.historyPhases.push(this.mode === 'live' ? 'live' : phase ? phase.kind : 'idle');
    while (this.historyTimes.length > 0 && simTime - this.historyTimes[0] > HISTORY_SECONDS) {
      this.historyTimes.shift();
      this.historyValues.shift();
      this.historyPhases.shift();
    }
    if (this.mode === 'cycle' && phase) {
      if (phase.kind === 'baseline') this.recBaseline.push(row);
      if (phase.kind === 'sample') this.recSample.push(row);
      if (phase.kind === 'baseline' || phase.kind === 'sample') {
        this.recTimes.push(simTime);
        this.recPhases.push(phase.kind);
      }
    }
  }

  private finishCycle(simTime: number): void {
    this.mode = 'idle';
    this.onPhaseChange?.(null);
    if (this.recBaseline.length === 0 || this.recSample.length === 0) return;
    const print = smellprint(this.recBaseline, this.recSample);
    const truth = this.lastTruth ?? { nearestSourceId: '', nearestSourceName: 'ambient air', distance: 99, topCompounds: [], rh: 0, tempC: 0 };
    let match: Measurement['match'] = null;
    for (const previous of this.measurements) {
      const similarity = cosineSimilarity(print, previous.smellprint);
      if (!match || similarity > match.similarity) match = { label: previous.label, similarity };
    }
    const measurement: Measurement = {
      id: this.nextId++,
      label: this.pendingLabel,
      color: this.pendingColor,
      simTime,
      method: this.method.name,
      baseline: this.recBaseline,
      sample: this.recSample,
      times: this.recTimes,
      phases: this.recPhases,
      smellprint: print,
      truth,
      match,
    };
    this.measurements.push(measurement);
    this.onMeasurement?.(measurement);
  }
}

/** Photoionization detector reading (ppb isobutylene-equivalent) from compound ppm. */
export function pidReading(ppm: ArrayLike<number>): number {
  let total = 0;
  COMPOUNDS.forEach((compound, j) => {
    if (compound.pidRF !== null) total += (ppm[j] * 1000) / compound.pidRF;
  });
  return total;
}
