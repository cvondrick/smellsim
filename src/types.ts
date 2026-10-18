// Shared data model for the room layout, simulation settings and worker messages.

export interface RoomSettings {
  width: number; // x extent (m)
  depth: number; // z extent (m)
  height: number; // y extent (m)
  cellSize: number; // simulation grid spacing (m)
  ambientTempC: number;
  ambientRH: number; // percent, at t = 0
  ozonePpb: number; // indoor ozone, drives terpene oxidation
  surfaceUptake: number; // multiplier on surface deposition velocities (carpet/fabric rich rooms > 1)
}

export type ItemType =
  | 'block'
  | 'table'
  | 'pillar'
  | 'fan'
  | 'ceilingFan'
  | 'heater'
  | 'hvac'
  | 'purifier'
  | 'source'
  | 'person';

export type BlockKind = 'wall' | 'partition' | 'shelf' | 'counter' | 'sofa' | 'cabinet' | 'bed' | 'box';

interface ItemBase {
  id: string;
  type: ItemType;
  name: string;
  x: number; // center (m)
  z: number; // center (m)
  yaw: number; // radians, rotation about +y
}

export interface BlockItem extends ItemBase {
  type: 'block';
  kind: BlockKind;
  y: number; // base elevation
  w: number; // local x size
  d: number; // local z size
  h: number; // height
  color: string;
}

export interface TableItem extends ItemBase {
  type: 'table';
  w: number;
  d: number;
  h: number; // top surface height
  color: string;
}

export interface PillarItem extends ItemBase {
  type: 'pillar';
  radius: number;
  h: number;
  color: string;
}

export interface FanItem extends ItemBase {
  type: 'fan';
  y: number; // hub height
  pitch: number; // radians, positive tilts up
  radius: number;
  speed: number; // exit air speed (m/s)
  oscillate: boolean;
  oscAmplitude: number; // radians
  oscPeriod: number; // seconds
  on: boolean;
}

export interface CeilingFanItem extends ItemBase {
  type: 'ceilingFan';
  radius: number;
  speed: number; // downdraft speed (m/s)
  reverse: boolean; // winter mode: updraft
  on: boolean;
}

export interface HeaterItem extends ItemBase {
  type: 'heater';
  w: number;
  d: number;
  h: number;
  power: number; // watts
  on: boolean;
}

export type FilterKind = 'none' | 'hepa' | 'carbon';

export interface HvacItem extends ItemBase {
  type: 'hvac';
  // (x, z) is the ceiling supply diffuser; (rx, rz) is the return grille.
  rx: number;
  rz: number;
  returnHigh: boolean; // return grille near ceiling instead of floor
  flow: number; // m^3/s recirculated
  supplyTempOffset: number; // K relative to return air (negative = cooling)
  filter: FilterKind;
  on: boolean;
}

export interface PurifierItem extends ItemBase {
  type: 'purifier';
  flow: number; // m^3/s
  filter: FilterKind;
  on: boolean;
}

export type EmissionPattern = 'steady' | 'puffs';

export interface SourceItem extends ItemBase {
  type: 'source';
  sourceType: string; // key into the source library
  y: number; // base elevation (top of the surface it sits on)
  strength: number; // multiplier on emission and headspace
  emitting: boolean;
  reservoirMinutes: number; // e-folding depletion time; 0 = never depletes
  pattern: EmissionPattern;
  puffPeriod: number; // seconds between puffs (pattern = 'puffs')
}

export interface PersonItem extends ItemBase {
  type: 'person';
  speed: number; // walking speed (m/s)
  behavior: 'wander' | 'stand';
  scent: string; // source type worn by the person ('' = none)
  shirtColor: string;
}

export type Item =
  | BlockItem
  | TableItem
  | PillarItem
  | FanItem
  | CeilingFanItem
  | HeaterItem
  | HvacItem
  | PurifierItem
  | SourceItem
  | PersonItem;

export interface Layout {
  version: 1;
  name: string;
  description: string;
  room: RoomSettings;
  items: Item[];
}

// ---------------------------------------------------------------------------
// Simulation settings and messages

export type VizMode = 'plume' | 'ppm' | 'oav' | 'humidity' | 'temperature' | 'speed';
export type ParticleMode = 'odor' | 'air' | 'off';

export interface SimSettings {
  paused: boolean;
  speed: number; // target simulated seconds per real second
  vizMode: VizMode;
  vizSource: string; // source item id, '' = all
  plumeDecades: number; // 'plume' mode shows dilution from 1 down to 10^-plumeDecades of headspace
  subtractBackground: boolean; // plume/ppm modes show only odor above the room's well-mixed level
  ppmLogMin: number; // log10 ppm lower bound for 'ppm' mode
  ppmLogMax: number;
  particleMode: ParticleMode;
  particleCount: number;
  sendVelocity: boolean;
  turbulence: number; // background eddy speed (m/s)
  vorticity: number; // vorticity confinement strength
  eddyDiffusivity: number; // m^2/s
  pressureIters: number;
}

export interface ProbeSpec {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface SourceInfo {
  id: string; // item id, or synthetic id for person-attached sources
  typeId: string;
  name: string;
  color: [number, number, number];
}

export interface GridInfo {
  nx: number; // including 1-cell solid border
  ny: number;
  nz: number;
  h: number;
  roomSize: [number, number, number];
}

export type ToWorker =
  | { type: 'init'; layout: Layout; settings: SimSettings }
  | { type: 'layout'; layout: Layout }
  | { type: 'settings'; settings: Partial<SimSettings> }
  | { type: 'probes'; probes: ProbeSpec[] }
  | { type: 'reset' }
  | { type: 'skip'; seconds: number }
  | { type: 'refill'; sourceId: string };

export interface FrameStats {
  sourceIds: string[];
  emitted: number[]; // mL of vapor emitted so far, per source
  airborne: number[]; // mL currently in the air
  decayed: number[]; // mL lost to chemistry and surfaces
  filtered: number[]; // mL captured by filters
  reservoir: number[]; // remaining reservoir fraction 0..1
  meanTempC: number;
  meanRH: number;
  maxSpeed: number;
}

export interface FrameMsg {
  type: 'frame';
  simTime: number;
  achievedSpeed: number;
  stepMs: number;
  dt: number;
  // probe samples recorded at every sim step since the last frame
  sampleTimes: Float64Array;
  probeIds: string[];
  probeStride: number;
  probeData: Float32Array; // nSamples * nProbes * probeStride
  people: Float32Array; // nPeople * PERSON_STRIDE
  peopleIds: string[];
  particles: Float32Array | null; // N * 4 (x, y, z, attr)
  volume: Uint8Array | null; // RGBA, interior cells only
  velocity: Float32Array | null; // interior cells, 3 comps, every other cell
  velocityDims: [number, number, number] | null;
  stats: FrameStats;
}

export interface ReadyMsg {
  type: 'ready';
  grid: GridInfo;
  sources: SourceInfo[];
  compoundIds: string[];
}

export type FromWorker = FrameMsg | ReadyMsg;

// Probe record layout (per probe, per sample):
//   [0 .. nCompounds)                  compound concentrations (ppm), including near-field headspace
//   [nCompounds + 0]                   absolute water vapor (ppm)
//   [nCompounds + 1]                   air temperature (C)
//   [nCompounds + 2]                   air speed (m/s)
//   [nCompounds + 3]                   distance to nearest source surface (m)
//   [nCompounds + 4]                   index of nearest source (-1 if none)
//   [nCompounds + 5 .. +nSources)      per-source concentration (ppm)
//   [... + nSources .. + 2 nSources)   per-source odor activity value (sum C/OT)
export const PROBE_EXTRA = 5;

// People record layout: x, z, yaw, walkSpeed, walkPhase, noticing(0/1)
export const PERSON_STRIDE = 6;
