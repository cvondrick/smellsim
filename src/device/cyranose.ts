// Cyranose 320 style handheld e-nose: pump, two inlets, sensor chamber and measurement cycle.
//
// Air reaches the 32-sensor chamber through one of two paths: the snout (sample inlet at the
// tip) or the side purge/baseline inlet that draws ambient air near the instrument body. A
// measurement records a baseline through the side inlet, then draws the sample through the
// snout, then purges. Tubing and chamber are modeled as two well-mixed volumes in series, so
// the response lags and smooths the concentration at the snout tip.

import { COMPOUNDS, WATER_INDEX } from '../chem/compounds';
import { cosineSimilarity, smellprint } from './analysis';
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

const TUBE_VOLUME_ML = 0.4;
const CHAMBER_VOLUME_ML = 1.5;
const HISTORY_SECONDS = 120;

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
  sensors = new SensorArray();
  method: Method = METHODS[0];
  mode: DeviceMode = 'idle';
  phaseIndex = 0;
  phaseTime = 0;
  readonly tube = new Float64Array(COMPOUNDS.length);
  readonly chamber = new Float64Array(COMPOUNDS.length);
  private initialized = false;
  private sampleClock = 0;
  private lastTime = -1;
  readonly resistance = new Float64Array(32);
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
    this.onPhaseChange?.(this.currentPhase);
  }

  abort(): void {
    this.mode = 'idle';
    this.onPhaseChange?.(null);
  }

  toggleLive(): void {
    if (this.mode === 'cycle') return;
    this.mode = this.mode === 'live' ? 'idle' : 'live';
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
      this.sensors.equilibrate(this.chamber);
      this.sensors.read(this.resistance);
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
      const source = inlet === 'snout' ? snout.ppm : side.ppm;
      const filter = inlet === 'side' && this.method.intakeFilter;
      const tubeBlend = 1 - Math.exp((-dt * chamberFlow) / TUBE_VOLUME_ML);
      const chamberBlend = 1 - Math.exp((-dt * chamberFlow) / CHAMBER_VOLUME_ML);
      for (let j = 0; j < this.chamber.length; j++) {
        const incoming = filter && j !== WATER_INDEX ? source[j] * 0.02 : source[j];
        this.tube[j] += (incoming - this.tube[j]) * tubeBlend;
        this.chamber[j] += (this.tube[j] - this.chamber[j]) * chamberBlend;
      }
    }
    this.sensors.step(dt, this.chamber);

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
    const row = this.sensors.read(new Float64Array(this.sensors.count));
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
