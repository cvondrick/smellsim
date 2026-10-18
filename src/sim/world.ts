// The simulated room: air flow, heat, humidity and odor transport, sources, ventilation, people.
//
// Odor transport uses one tracer field per (source, decay class). Compounds of a source that
// decay at similar rates (ozone chemistry + surface uptake) share a channel, so every compound
// decays at its own rate while the number of fields stays small. Because transport is linear,
// compound concentrations are recovered exactly from channel concentrations and composition.

import {
  COMPOUNDS,
  COMPOUND_INDEX,
  WATER_INDEX,
  decayRate,
  filterEfficiency,
  saturationWaterPpm,
} from '../chem/compounds';
import { getSourceType, hexToRgb, type SourceType } from '../chem/sourceTypes';
import { PURIFIER_SIZE, areaToVolume, buildGrid, buildWalkable, type Grid } from '../room/voxelize';
import type {
  FanItem,
  FilterKind,
  FrameStats,
  HeaterItem,
  HvacItem,
  Layout,
  PersonItem,
  ProbeSpec,
  PurifierItem,
  SimSettings,
  SourceInfo,
  SourceItem,
  CeilingFanItem,
} from '../types';
import { PERSON_STRIDE, PROBE_EXTRA } from '../types';
import { FluidSim, type ScalarField } from './fluid';
import { Particles, type ParticleEmitter } from './particles';
import { PeopleSim } from './people';

const RHO_CP = 1206; // J / (m^3 K), air
const STILL_AIR_MASS_TRANSFER = 0.002; // m/s
const PERSON_HEAT_W = 80;
const PERSON_BREATH_WATER = 15; // ppm*m^3/s of water vapor (~40 g/h)
// Convective exchange with walls, floor and furniture (~4 W/m2K over all surfaces) pulls the
// air back toward ambient with a time scale of a few minutes.
const TEMPERATURE_RELAX_S = 300;

interface Channel {
  key: string;
  sourceIndex: number;
  field: ScalarField;
  k: number;
  compounds: number[];
  fractions: number[];
  headspace: number; // ppm at the source surface, strength 1
  oavCoef: number; // sum(fraction / threshold)
  carbonEff: number;
  expected: number; // mL of vapor that should be airborne (mass fixer target)
  emitted: number;
  decayed: number;
  filtered: number;
}

interface EmissionPoint {
  x: number;
  y: number;
  z: number;
}

interface SourceRuntime {
  key: string;
  info: SourceInfo;
  type: SourceType;
  item: SourceItem | null;
  attachedTo: string[]; // person ids for person-attached sources
  attachHeight: number;
  attachRadius: number;
  channels: Channel[];
  reservoir: number;
  emissionRate: number; // last total emission, mL/s
}

interface VentLoop {
  supply: number[];
  ret: number[];
  flow: number;
  filter: FilterKind;
  tempOffset: number;
}

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

export class World {
  layout!: Layout;
  grid!: Grid;
  fluid!: FluidSim;
  temperature!: ScalarField; // K above ambient
  water!: ScalarField; // ppm above ambient
  waterExpected = 0;
  heatExpected = 0; // integral of temperature excess (K m^3), for energy conservation
  sources: SourceRuntime[] = [];
  private channelsBySource = new Map<string, Channel[]>();
  vents: VentLoop[] = [];
  heaters: { cells: number[]; item: HeaterItem }[] = [];
  fans: FanItem[] = [];
  ceilingFans: CeilingFanItem[] = [];
  people!: PeopleSim;
  particles: Particles;
  probes: ProbeSpec[] = [];
  settings: SimSettings;
  time = 0;
  private stepCount = 0;
  private random = mulberry32(1234);
  ambientWaterPpm = 0;
  private areaToVolumeRatio = 2;
  private velocityScratch = new Float32Array(3);

  constructor(layout: Layout, settings: SimSettings) {
    this.settings = settings;
    this.particles = new Particles(this.random);
    this.setLayout(layout);
  }

  get compoundCount(): number {
    return COMPOUNDS.length;
  }

  get probeStride(): number {
    return COMPOUNDS.length + PROBE_EXTRA + 2 * this.sources.length;
  }

  // ------------------------------------------------------------------ layout

  setLayout(layout: Layout): void {
    const previousLayout = this.layout;
    this.layout = layout;
    const grid = buildGrid(layout);
    const sameDims =
      this.grid !== undefined && grid.nx === this.grid.nx && grid.ny === this.grid.ny && grid.nz === this.grid.nz && grid.h === this.grid.h;
    const roomChanged =
      !previousLayout ||
      previousLayout.room.ambientTempC !== layout.room.ambientTempC ||
      previousLayout.room.ambientRH !== layout.room.ambientRH;
    this.grid = grid;
    if (sameDims) {
      this.fluid.setSolid(grid.solid);
      this.fluid.divSource.fill(0);
    } else {
      this.fluid = new FluidSim(grid);
      this.temperature = this.fluid.addScalar(1 / TEMPERATURE_RELAX_S);
      this.water = this.fluid.addScalar(0);
      this.waterExpected = 0;
      this.heatExpected = 0;
      this.channelsBySource.clear();
      this.time = 0;
      this.particles.count = -1; // force reconfigure
    }
    if (roomChanged) {
      this.ambientWaterPpm = (layout.room.ambientRH / 100) * saturationWaterPpm(layout.room.ambientTempC);
    }
    this.areaToVolumeRatio = areaToVolume(layout);

    this.buildSources();
    this.buildVentilation();
    this.buildHeaters();
    this.fans = layout.items.filter((item): item is FanItem => item.type === 'fan');
    this.ceilingFans = layout.items.filter((item): item is CeilingFanItem => item.type === 'ceilingFan');

    const previousPeople = this.people ? this.people.people : [];
    this.people = new PeopleSim(buildWalkable(grid), grid.nx, grid.nz, grid.h, this.random);
    this.people.setPointsOfInterest(
      layout.items.filter((item): item is SourceItem => item.type === 'source').map((item) => [item.x, item.z] as [number, number]),
    );
    this.people.sync(
      layout.items.filter((item): item is PersonItem => item.type === 'person'),
      previousPeople,
    );

    // Newly solid cells destroyed some mass; re-baseline the conservation targets.
    for (const source of this.sources) {
      for (const channel of source.channels) channel.expected = this.fluid.total(channel.field.data) * this.fluid.cellVolume;
    }
    this.waterExpected = this.fluid.total(this.water.data) * this.fluid.cellVolume;
    this.heatExpected = this.fluid.total(this.temperature.data) * this.fluid.cellVolume;
    this.particles.configure(this.settings.particleCount, this.settings.particleMode, this.fluid);
  }

  private buildSources(): void {
    const layout = this.layout;
    const specs: { key: string; id: string; typeId: string; name: string; item: SourceItem | null; attachedTo: string[]; height: number; radius: number }[] = [];
    for (const item of layout.items) {
      if (item.type === 'source') {
        specs.push({ key: `${item.id}|${item.sourceType}`, id: item.id, typeId: item.sourceType, name: item.name, item, attachedTo: [], height: 0, radius: 0 });
      }
    }
    const persons = layout.items.filter((item): item is PersonItem => item.type === 'person');
    if (persons.length > 0) {
      specs.push({ key: 'people|human', id: 'people', typeId: 'human', name: 'People (breath and skin)', item: null, attachedTo: persons.map((person) => person.id), height: 1.0, radius: 0.25 });
    }
    for (const person of persons) {
      if (!person.scent) continue;
      const scentType = getSourceType(person.scent);
      specs.push({ key: `${person.id}|scent|${person.scent}`, id: `${person.id}:scent`, typeId: person.scent, name: `${scentType.name} on ${person.name}`, item: null, attachedTo: [person.id], height: 1.45, radius: 0.12 });
    }

    const previous = new Map(this.sources.map((source) => [source.key, source]));
    const keep = new Set(specs.map((spec) => spec.key));
    for (const [key, channels] of this.channelsBySource) {
      if (!keep.has(key)) {
        for (const channel of channels) this.fluid.removeScalar(channel.field);
        this.channelsBySource.delete(key);
      }
    }

    const room = layout.room;
    this.sources = specs.map((spec, sourceIndex) => {
      const type = getSourceType(spec.typeId);
      let channels = this.channelsBySource.get(spec.key);
      if (!channels) {
        channels = this.createChannels(spec.key, type);
        this.channelsBySource.set(spec.key, channels);
      }
      for (const channel of channels) {
        channel.sourceIndex = sourceIndex;
        // Update decay rates for the current room chemistry; grouping stays fixed.
        let weighted = 0;
        for (let m = 0; m < channel.compounds.length; m++) {
          weighted += channel.fractions[m] * decayRate(COMPOUNDS[channel.compounds[m]], room.ozonePpb, this.areaToVolumeRatio, room.surfaceUptake);
        }
        channel.k = weighted;
        channel.field.decayPerSecond = weighted;
      }
      const old = previous.get(spec.key);
      return {
        key: spec.key,
        info: { id: spec.id, typeId: spec.typeId, name: spec.name, color: hexToRgb(type.color) },
        type,
        item: spec.item,
        attachedTo: spec.attachedTo,
        attachHeight: spec.height,
        attachRadius: spec.radius,
        channels,
        reservoir: old ? old.reservoir : 1,
        emissionRate: 0,
      };
    });
  }

  private createChannels(key: string, type: SourceType): Channel[] {
    const room = this.layout.room;
    const buckets = new Map<number, { compounds: number[]; ppm: number[]; rates: number[] }>();
    for (const [compoundId, ppm] of Object.entries(type.headspace)) {
      const compoundIndex = COMPOUND_INDEX[compoundId];
      if (compoundIndex === undefined || ppm <= 0) continue;
      const rate = decayRate(COMPOUNDS[compoundIndex], room.ozonePpb, this.areaToVolumeRatio, room.surfaceUptake);
      const bucket = rate < 3e-6 ? -100 : Math.round(Math.log10(rate) * 2);
      const entry = buckets.get(bucket) ?? { compounds: [], ppm: [], rates: [] };
      entry.compounds.push(compoundIndex);
      entry.ppm.push(ppm);
      entry.rates.push(rate);
      buckets.set(bucket, entry);
    }
    const channels: Channel[] = [];
    for (const [bucket, entry] of buckets) {
      const total = entry.ppm.reduce((sum, value) => sum + value, 0);
      const fractions = entry.ppm.map((value) => value / total);
      let k = 0;
      let oavCoef = 0;
      let carbonEff = 0;
      fractions.forEach((fraction, m) => {
        const compound = COMPOUNDS[entry.compounds[m]];
        k += fraction * entry.rates[m];
        if (isFinite(compound.ot)) oavCoef += fraction / compound.ot;
        carbonEff += fraction * filterEfficiency(compound, 'carbon');
      });
      channels.push({
        key: `${key}|${bucket}`,
        sourceIndex: 0,
        field: this.fluid.addScalar(k),
        k,
        compounds: entry.compounds,
        fractions,
        headspace: total,
        oavCoef,
        carbonEff,
        expected: 0,
        emitted: 0,
        decayed: 0,
        filtered: 0,
      });
    }
    return channels;
  }

  /** A square patch of fluid cells at a given layer around (x, z). */
  private patch(x: number, z: number, j: number, side: number): number[] {
    const { nx, nz, h } = this.grid;
    const fluid = this.fluid;
    const ci = Math.floor(x / h + 1);
    const ck = Math.floor(z / h + 1);
    const cells: number[] = [];
    const half = Math.floor(side / 2);
    for (let dk = -half; dk < side - half; dk++) {
      for (let di = -half; di < side - half; di++) {
        const i = Math.min(nx - 2, Math.max(1, ci + di));
        const k = Math.min(nz - 2, Math.max(1, ck + dk));
        const idx = i + fluid.sy * j + fluid.sz * k;
        if (!fluid.solid[idx] && !cells.includes(idx)) cells.push(idx);
      }
    }
    return cells;
  }

  private buildVentilation(): void {
    const { ny, h } = this.grid;
    const fluid = this.fluid;
    const cellVolume = fluid.cellVolume;
    this.vents = [];
    const addLoop = (supply: number[], ret: number[], flow: number, filter: FilterKind, tempOffset: number) => {
      if (supply.length === 0 || ret.length === 0 || flow <= 0) return;
      for (const idx of supply) fluid.divSource[idx] += flow / (supply.length * cellVolume);
      for (const idx of ret) fluid.divSource[idx] -= flow / (ret.length * cellVolume);
      this.vents.push({ supply, ret, flow, filter, tempOffset });
    };
    for (const item of this.layout.items) {
      if (item.type === 'hvac') {
        const hvac = item as HvacItem;
        if (!hvac.on) continue;
        const side = Math.max(2, Math.ceil(Math.sqrt((0.6 * hvac.flow) / cellVolume)));
        const supply = this.patch(hvac.x, hvac.z, ny - 2, side);
        const ret = this.patch(hvac.rx, hvac.rz, hvac.returnHigh ? ny - 2 : 1, side);
        addLoop(supply, ret, hvac.flow, hvac.filter, hvac.supplyTempOffset);
      } else if (item.type === 'purifier') {
        const purifier = item as PurifierItem;
        if (!purifier.on) continue;
        const topJ = Math.min(ny - 2, Math.floor(PURIFIER_SIZE[1] / h + 1) + 1);
        const supply = this.patch(purifier.x, purifier.z, topJ, 2);
        // intake on the front face, near the floor
        const fx = purifier.x + Math.sin(purifier.yaw) * (PURIFIER_SIZE[2] / 2 + h * 0.6);
        const fz = purifier.z + Math.cos(purifier.yaw) * (PURIFIER_SIZE[2] / 2 + h * 0.6);
        const ret = [...this.patch(fx, fz, 1, 2), ...this.patch(fx, fz, 2, 2)];
        addLoop(supply, ret, purifier.flow, purifier.filter, 0);
      }
    }
  }

  private buildHeaters(): void {
    const fluid = this.fluid;
    const h = this.grid.h;
    this.heaters = [];
    for (const item of this.layout.items) {
      if (item.type !== 'heater') continue;
      const heater = item as HeaterItem;
      const cells: number[] = [];
      const reach = Math.hypot(heater.w, heater.d) / 2 + h * 1.2;
      const cos = Math.cos(heater.yaw);
      const sin = Math.sin(heater.yaw);
      for (let y = 0.1; y <= 0.1 + heater.h + h * 1.5; y += h * 0.5) {
        for (let dx = -reach; dx <= reach; dx += h * 0.5) {
          for (let dz = -reach; dz <= reach; dz += h * 0.5) {
            const lx = dx * cos - dz * sin;
            const lz = dx * sin + dz * cos;
            if (Math.abs(lx) > heater.w / 2 + h || Math.abs(lz) > heater.d / 2 + h) continue;
            const x = heater.x + dx;
            const z = heater.z + dz;
            if (fluid.isSolidAt(x, y, z)) continue;
            const idx = fluid.cellIndexAt(x, y, z);
            if (!cells.includes(idx)) cells.push(idx);
          }
        }
      }
      this.heaters.push({ cells, item: heater });
    }
  }

  // ------------------------------------------------------------------ helpers

  /** Distribute an amount (field units * m^3) into the fluid cells around a point. */
  private splat(field: Float32Array, x: number, y: number, z: number, amount: number): void {
    const fluid = this.fluid;
    const { sy, sz, solid, h } = fluid;
    const gx = Math.min(fluid.nx - 2, Math.max(1, x / h + 0.5));
    let gy = Math.min(fluid.ny - 2, Math.max(1, y / h + 0.5));
    const gz = Math.min(fluid.nz - 2, Math.max(1, z / h + 0.5));
    for (let attempt = 0; attempt < 4; attempt++) {
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      const k0 = Math.floor(gz);
      const fx = gx - i0;
      const fy = gy - j0;
      const fz = gz - k0;
      let total = 0;
      const indices: number[] = [];
      const weights: number[] = [];
      for (let dk = 0; dk < 2; dk++) {
        for (let dj = 0; dj < 2; dj++) {
          for (let di = 0; di < 2; di++) {
            const idx = i0 + di + sy * (j0 + dj) + sz * (k0 + dk);
            if (solid[idx]) continue;
            const weight = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy) * (dk ? fz : 1 - fz) + 1e-4;
            indices.push(idx);
            weights.push(weight);
            total += weight;
          }
        }
      }
      if (total > 0) {
        const scale = amount / (total * fluid.cellVolume);
        for (let m = 0; m < indices.length; m++) field[indices[m]] += weights[m] * scale;
        return;
      }
      gy = Math.min(fluid.ny - 2, gy + 1);
    }
  }

  private personPosition(id: string): [number, number] | null {
    const person = this.people.people.find((candidate) => candidate.id === id);
    return person ? [person.x, person.z] : null;
  }

  private emissionPoints(source: SourceRuntime): EmissionPoint[] {
    if (source.item) {
      const item = source.item;
      return [{ x: item.x, y: item.y + source.type.size[1] * 0.85, z: item.z }];
    }
    const points: EmissionPoint[] = [];
    for (const id of source.attachedTo) {
      const position = this.personPosition(id);
      if (position) points.push({ x: position[0], y: source.attachHeight, z: position[1] });
    }
    return points;
  }

  /** Multiplier on the source's headspace concentration right now. */
  private headspaceFactor(source: SourceRuntime): number {
    if (!source.item) return 1;
    const item = source.item;
    if (!item.emitting) return 0;
    let factor = item.strength * source.reservoir;
    if (item.pattern === 'puffs') {
      const phase = this.time % Math.max(2, item.puffPeriod);
      factor *= phase < 1.5 ? 3 : 0.05;
    }
    return factor;
  }

  /** Multiplier on the emission rate right now (puffs concentrate the average into bursts). */
  private emissionFactor(source: SourceRuntime): number {
    if (!source.item) return 1;
    const item = source.item;
    if (!item.emitting) return 0;
    let factor = item.strength * source.reservoir;
    if (item.pattern === 'puffs') {
      const period = Math.max(2, item.puffPeriod);
      factor *= this.time % period < 1.5 ? period / 1.5 : 0;
    }
    return factor;
  }

  private massTransfer(x: number, y: number, z: number): number {
    this.fluid.sampleVelocity(x, y, z, this.velocityScratch);
    const speed = Math.hypot(this.velocityScratch[0], this.velocityScratch[1], this.velocityScratch[2]);
    return STILL_AIR_MASS_TRANSFER + 0.006 * Math.sqrt(speed);
  }

  // ------------------------------------------------------------------ step

  step(dt: number): void {
    const fluid = this.fluid;
    this.people.update(dt, this.time);

    this.heatExpected *= Math.exp(-dt / TEMPERATURE_RELAX_S);
    for (const source of this.sources) {
      for (const channel of source.channels) {
        const keep = Math.exp(-channel.k * dt);
        channel.decayed += channel.expected * (1 - keep);
        channel.expected *= keep;
      }
    }
    fluid.advect(dt);

    this.applyFans(dt);
    this.applyCeilingFans(dt);
    this.applyPeopleMotion(dt);
    this.applyBuoyancy(dt);
    this.injectEddies(dt);
    fluid.confineVorticity(this.settings.vorticity, dt);
    fluid.project(this.settings.pressureIters);

    this.emitSources(dt);
    this.emitPeopleHeatAndBreath(dt);
    this.emitHeaters(dt);
    this.ventilate(dt);

    const diffusivity = this.settings.eddyDiffusivity;
    if (diffusivity > 0) {
      fluid.diffuse(this.temperature, diffusivity * 1.5, dt);
      fluid.diffuse(this.water, diffusivity, dt);
      for (const source of this.sources) for (const channel of source.channels) fluid.diffuse(channel.field, diffusivity, dt);
    }

    this.stepCount++;
    if (this.stepCount % 3 === 0) this.fixMass();

    this.particles.update(dt, fluid, this.particleEmitters(), diffusivity);
    this.time += dt;
  }

  private applyFanDisk(cx: number, cy: number, cz: number, dir: [number, number, number], radius: number, speed: number, swirl: number, dt: number): void {
    const fluid = this.fluid;
    const { u, v, w, h, solid } = fluid;
    const reach = radius + h;
    const blend = 1 - Math.exp(-dt / 0.08);
    const i0 = Math.max(1, Math.floor((cx - reach) / h + 1));
    const i1 = Math.min(fluid.nx - 2, Math.floor((cx + reach) / h + 1));
    const j0 = Math.max(1, Math.floor((cy - reach) / h + 1));
    const j1 = Math.min(fluid.ny - 2, Math.floor((cy + reach) / h + 1));
    const k0 = Math.max(1, Math.floor((cz - reach) / h + 1));
    const k1 = Math.min(fluid.nz - 2, Math.floor((cz + reach) / h + 1));
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const idx = i + fluid.sy * j + fluid.sz * k;
          if (solid[idx]) continue;
          const rx = (i - 0.5) * h - cx;
          const ry = (j - 0.5) * h - cy;
          const rz = (k - 0.5) * h - cz;
          const axial = rx * dir[0] + ry * dir[1] + rz * dir[2];
          if (Math.abs(axial) > 0.75 * h) continue;
          const px = rx - axial * dir[0];
          const py = ry - axial * dir[1];
          const pz = rz - axial * dir[2];
          const radial = Math.hypot(px, py, pz);
          if (radial > radius + 0.5 * h) continue;
          const profile = radial < radius ? 1 : 0.5;
          // tangential swirl = dir x radial
          const sx = (dir[1] * pz - dir[2] * py) / Math.max(radius, 1e-3);
          const sy = (dir[2] * px - dir[0] * pz) / Math.max(radius, 1e-3);
          const sz = (dir[0] * py - dir[1] * px) / Math.max(radius, 1e-3);
          const tu = (dir[0] * speed + sx * swirl) * profile;
          const tv = (dir[1] * speed + sy * swirl) * profile;
          const tw = (dir[2] * speed + sz * swirl) * profile;
          u[idx] += (tu - u[idx]) * blend;
          v[idx] += (tv - v[idx]) * blend;
          w[idx] += (tw - w[idx]) * blend;
        }
      }
    }
  }

  fanDirection(fan: FanItem, time: number): [number, number, number] {
    const yaw = fan.yaw + (fan.oscillate ? fan.oscAmplitude * Math.sin((2 * Math.PI * time) / Math.max(1, fan.oscPeriod)) : 0);
    return [Math.sin(yaw) * Math.cos(fan.pitch), Math.sin(fan.pitch), Math.cos(yaw) * Math.cos(fan.pitch)];
  }

  private applyFans(dt: number): void {
    for (const fan of this.fans) {
      if (!fan.on || fan.speed <= 0) continue;
      const dir = this.fanDirection(fan, this.time);
      const offset = 0.1;
      this.applyFanDisk(fan.x + dir[0] * offset, fan.y + dir[1] * offset, fan.z + dir[2] * offset, dir, fan.radius, fan.speed, fan.speed * 0.2, dt);
    }
  }

  private applyCeilingFans(dt: number): void {
    const height = this.grid.roomSize[1];
    for (const fan of this.ceilingFans) {
      if (!fan.on || fan.speed <= 0) continue;
      const y = Math.max(1, height - 0.45 - this.grid.h * 0.5);
      const dir: [number, number, number] = fan.reverse ? [0, 1, 0] : [0, -1, 0];
      this.applyFanDisk(fan.x, y, fan.z, dir, fan.radius, fan.speed, fan.speed * 0.5, dt);
    }
  }

  private applyPeopleMotion(dt: number): void {
    const fluid = this.fluid;
    const { u, w, h, solid } = fluid;
    const blend = 1 - Math.exp(-dt / 0.3);
    const radius = 0.25;
    for (const person of this.people.people) {
      if (Math.abs(person.vx) + Math.abs(person.vz) < 0.01) continue;
      const i0 = Math.max(1, Math.floor((person.x - radius) / h + 1));
      const i1 = Math.min(fluid.nx - 2, Math.floor((person.x + radius) / h + 1));
      const k0 = Math.max(1, Math.floor((person.z - radius) / h + 1));
      const k1 = Math.min(fluid.nz - 2, Math.floor((person.z + radius) / h + 1));
      const j1 = Math.min(fluid.ny - 2, Math.floor(1.75 / h + 1));
      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          const dx = (i - 0.5) * h - person.x;
          const dz = (k - 0.5) * h - person.z;
          if (dx * dx + dz * dz > (radius + 0.5 * h) ** 2) continue;
          for (let j = 1; j <= j1; j++) {
            const idx = i + fluid.sy * j + fluid.sz * k;
            if (solid[idx]) continue;
            u[idx] += (person.vx - u[idx]) * blend;
            w[idx] += (person.vz - w[idx]) * blend;
          }
        }
      }
    }
  }

  private applyBuoyancy(dt: number): void {
    const fluid = this.fluid;
    const t = this.temperature.data;
    const v = fluid.v;
    const cells = fluid.fluidCells;
    const mean = fluid.mean(t);
    const gBeta = (9.81 / (273.15 + this.layout.room.ambientTempC)) * dt;
    for (let c = 0; c < cells.length; c++) {
      const idx = cells[c];
      v[idx] += gBeta * (t[idx] - mean);
    }
  }

  /** Random swirls standing in for unresolved background turbulence. */
  private injectEddies(dt: number): void {
    const strength = this.settings.turbulence;
    if (strength <= 0) return;
    const fluid = this.fluid;
    const { u, v, w, h, solid } = fluid;
    const [rw, rh, rd] = this.grid.roomSize;
    const expected = rw * rh * rd * 0.02 * dt;
    let count = Math.floor(expected);
    if (this.random() < expected - count) count++;
    const radius = 2.5 * h;
    const reachCells = Math.ceil((2 * radius) / h);
    for (let e = 0; e < count; e++) {
      const center = fluid.fluidCells[Math.floor(this.random() * fluid.fluidCells.length)];
      const [cx, cy, cz] = fluid.cellCenter(center);
      let ax = this.random() - 0.5;
      let ay = (this.random() - 0.5) * 0.6;
      let az = this.random() - 0.5;
      const norm = Math.hypot(ax, ay, az) + 1e-6;
      ax /= norm;
      ay /= norm;
      az /= norm;
      const amplitude = strength * (0.5 + this.random());
      const ci = Math.floor(cx / h + 1);
      const cj = Math.floor(cy / h + 1);
      const ck = Math.floor(cz / h + 1);
      for (let dk = -reachCells; dk <= reachCells; dk++) {
        const k = ck + dk;
        if (k < 1 || k > fluid.nz - 2) continue;
        for (let dj = -reachCells; dj <= reachCells; dj++) {
          const j = cj + dj;
          if (j < 1 || j > fluid.ny - 2) continue;
          for (let di = -reachCells; di <= reachCells; di++) {
            const i = ci + di;
            if (i < 1 || i > fluid.nx - 2) continue;
            const idx = i + fluid.sy * j + fluid.sz * k;
            if (solid[idx]) continue;
            const rx = di * h;
            const ry = dj * h;
            const rz = dk * h;
            const falloff = Math.exp(-(rx * rx + ry * ry + rz * rz) / (radius * radius)) * (amplitude / radius);
            u[idx] += (ay * rz - az * ry) * falloff;
            v[idx] += (az * rx - ax * rz) * falloff;
            w[idx] += (ax * ry - ay * rx) * falloff;
          }
        }
      }
    }
  }

  private emitSources(dt: number): void {
    const temperature = this.temperature.data;
    const water = this.water.data;
    for (const source of this.sources) {
      const factor = this.emissionFactor(source);
      source.emissionRate = 0;
      if (factor <= 0) continue;
      const points = this.emissionPoints(source);
      if (points.length === 0) continue;
      const type = source.type;
      let firstMassTransfer = STILL_AIR_MASS_TRANSFER;
      points.forEach((point, pointIndex) => {
        const km = this.massTransfer(point.x, point.y, point.z);
        if (pointIndex === 0) firstMassTransfer = km;
        for (const channel of source.channels) {
          const rate = km * type.area * channel.headspace * factor; // mL/s
          const amount = rate * dt;
          this.splat(channel.field.data, point.x, point.y, point.z, amount);
          channel.expected += amount;
          channel.emitted += amount;
          source.emissionRate += rate;
        }
        if (type.waterPpm > 0) {
          const amount = km * type.area * type.waterPpm * factor * dt;
          this.splat(water, point.x, point.y, point.z, amount);
          this.waterExpected += amount;
        }
        if (type.heatW > 0 && source.item) {
          const heatFactor = source.item.emitting ? source.reservoir : 0;
          const heat = (type.heatW * heatFactor * dt) / RHO_CP;
          this.splat(temperature, point.x, point.y + 0.05, point.z, heat);
          this.heatExpected += heat;
        }
      });
      const item = source.item;
      if (item && item.reservoirMinutes > 0 && item.emitting) {
        const tau = item.reservoirMinutes * 60;
        source.reservoir *= Math.exp(-(dt / tau) * (firstMassTransfer / STILL_AIR_MASS_TRANSFER));
      }
    }
  }

  private emitPeopleHeatAndBreath(dt: number): void {
    const temperature = this.temperature.data;
    const water = this.water.data;
    for (const person of this.people.people) {
      const heat = (PERSON_HEAT_W * dt) / RHO_CP / 3;
      for (const y of [0.5, 1.0, 1.5]) this.splat(temperature, person.x, y, person.z, heat);
      this.heatExpected += 3 * heat;
      const breath = PERSON_BREATH_WATER * dt;
      this.splat(water, person.x + Math.sin(person.yaw) * 0.2, 1.6, person.z + Math.cos(person.yaw) * 0.2, breath);
      this.waterExpected += breath;
    }
  }

  private emitHeaters(dt: number): void {
    const temperature = this.temperature.data;
    const cellVolume = this.fluid.cellVolume;
    for (const heater of this.heaters) {
      if (!heater.item.on || heater.cells.length === 0) continue;
      const delta = (heater.item.power * dt) / (RHO_CP * cellVolume * heater.cells.length);
      for (const idx of heater.cells) temperature[idx] += delta;
      this.heatExpected += (heater.item.power * dt) / RHO_CP;
    }
  }

  /** Recirculating ventilation: move air from return to supply, filtering on the way. */
  private ventilate(dt: number): void {
    const cellVolume = this.fluid.cellVolume;
    for (const loop of this.vents) {
      const fraction = Math.min(0.9, (loop.flow * dt) / (loop.ret.length * cellVolume));
      const supplyFraction = Math.min(1, (loop.flow * dt) / (loop.supply.length * cellVolume));
      const transfer = (data: Float32Array, efficiency: number): number => {
        let removed = 0;
        for (const idx of loop.ret) {
          const taken = data[idx] * fraction;
          data[idx] -= taken;
          removed += taken;
        }
        const injected = (removed * (1 - efficiency)) / loop.supply.length;
        for (const idx of loop.supply) data[idx] += injected;
        return removed * efficiency * cellVolume;
      };
      transfer(this.water.data, 0);
      transfer(this.temperature.data, 0);
      if (loop.tempOffset !== 0) {
        for (const idx of loop.supply) this.temperature.data[idx] += loop.tempOffset * supplyFraction;
        this.heatExpected += loop.tempOffset * supplyFraction * loop.supply.length * cellVolume;
      }
      for (const source of this.sources) {
        for (const channel of source.channels) {
          const efficiency = loop.filter === 'carbon' ? channel.carbonEff : 0;
          const captured = transfer(channel.field.data, efficiency);
          channel.filtered += captured;
          channel.expected = Math.max(0, channel.expected - captured);
        }
      }
    }
  }

  /** Restore exact mass conservation lost by semi-Lagrangian advection. */
  private fixMass(): void {
    const fluid = this.fluid;
    const fix = (data: Float32Array, expected: number) => {
      if (expected <= 0) return;
      const actual = fluid.total(data) * fluid.cellVolume;
      if (actual <= 1e-12) return;
      const ratio = Math.min(1.25, Math.max(0.8, expected / actual));
      if (Math.abs(ratio - 1) > 1e-5) fluid.scale(data, ratio);
    };
    for (const source of this.sources) for (const channel of source.channels) fix(channel.field.data, channel.expected);
    fix(this.water.data, this.waterExpected);
    // Temperature excess can be negative (cooling), so correct it additively and uniformly.
    const heatActual = fluid.total(this.temperature.data) * fluid.cellVolume;
    const offset = (this.heatExpected - heatActual) / (fluid.fluidCount * fluid.cellVolume);
    if (Math.abs(offset) > 1e-7) {
      const t = this.temperature.data;
      const cells = fluid.fluidCells;
      for (let c = 0; c < cells.length; c++) t[cells[c]] += offset;
    }
  }

  private particleEmitters(): ParticleEmitter[] {
    const emitters: ParticleEmitter[] = [];
    this.sources.forEach((source, sourceIndex) => {
      if (source.emissionRate <= 0) return;
      const points = this.emissionPoints(source);
      const [sw, sh, sd] = source.type.size;
      // sqrt compresses the huge range between solvents and faint materials
      const rate = Math.sqrt(source.emissionRate) / Math.max(1, points.length);
      for (const point of points) {
        emitters.push({
          sourceIndex,
          rate,
          x: point.x,
          y: source.item ? source.item.y + sh * 0.6 : point.y - 0.3,
          z: point.z,
          spreadX: source.item ? sw : 0.4,
          spreadY: source.item ? sh * 0.5 : 0.6,
          spreadZ: source.item ? sd : 0.4,
        });
      }
    });
    return emitters;
  }

  // ------------------------------------------------------------------ probes

  /** Distance from a point to the source's surface (oriented box, or person body). */
  private distanceToSource(source: SourceRuntime, x: number, y: number, z: number): number {
    if (source.item) {
      const item = source.item;
      const [sw, sh, sd] = source.type.size;
      const dx = x - item.x;
      const dz = z - item.z;
      const cos = Math.cos(item.yaw);
      const sin = Math.sin(item.yaw);
      const lx = Math.abs(dx * cos - dz * sin) - sw / 2;
      const lz = Math.abs(dx * sin + dz * cos) - sd / 2;
      const ly = Math.abs(y - (item.y + sh / 2)) - sh / 2;
      return Math.hypot(Math.max(lx, 0), Math.max(ly, 0), Math.max(lz, 0));
    }
    let best = Infinity;
    for (const id of source.attachedTo) {
      const position = this.personPosition(id);
      if (!position) continue;
      const radial = Math.hypot(x - position[0], z - position[1]) - source.attachRadius;
      const vertical = source.attachedTo.length > 1 ? Math.max(0, y - 1.75, -y) : Math.abs(y - source.attachHeight) - 0.08;
      best = Math.min(best, Math.hypot(Math.max(radial, 0), Math.max(vertical, 0)));
    }
    return best;
  }

  sampleProbe(x: number, y: number, z: number, out: Float32Array, offset: number): void {
    const fluid = this.fluid;
    const nC = COMPOUNDS.length;
    const nS = this.sources.length;
    const stride = this.probeStride;
    for (let m = 0; m < stride; m++) out[offset + m] = 0;
    fluid.sampleVelocity(x, y, z, this.velocityScratch);
    const speed = Math.hypot(this.velocityScratch[0], this.velocityScratch[1], this.velocityScratch[2]);
    const boundaryLayer = 0.025 / (1 + 2 * speed);
    const waterGrid = fluid.sampleFluid(this.water.data, x, y, z);
    let waterNear = 0;
    let nearestDistance = Infinity;
    let nearestIndex = -1;
    this.sources.forEach((source, sourceIndex) => {
      const distance = this.distanceToSource(source, x, y, z);
      if (distance < nearestDistance && source.item) {
        nearestDistance = distance;
        nearestIndex = sourceIndex;
      }
      const near = distance < 0.4 ? Math.exp(-distance / boundaryLayer) : 0;
      const factor = near > 0 ? this.headspaceFactor(source) : 0;
      let sourcePpm = 0;
      let sourceOav = 0;
      for (const channel of source.channels) {
        const grid = fluid.sampleFluid(channel.field.data, x, y, z);
        const concentration = grid + near * Math.max(0, channel.headspace * factor - grid);
        sourcePpm += concentration;
        sourceOav += concentration * channel.oavCoef;
        for (let m = 0; m < channel.compounds.length; m++) out[offset + channel.compounds[m]] += concentration * channel.fractions[m];
      }
      if (source.type.waterPpm > 0) waterNear = Math.max(waterNear, near * Math.max(0, source.type.waterPpm * factor - waterGrid));
      out[offset + nC + PROBE_EXTRA + sourceIndex] = sourcePpm;
      out[offset + nC + PROBE_EXTRA + nS + sourceIndex] = sourceOav;
    });
    const waterPpm = this.ambientWaterPpm + waterGrid + waterNear;
    out[offset + WATER_INDEX] = waterPpm;
    out[offset + nC] = waterPpm;
    out[offset + nC + 1] = this.layout.room.ambientTempC + fluid.sampleFluid(this.temperature.data, x, y, z);
    out[offset + nC + 2] = speed;
    out[offset + nC + 3] = isFinite(nearestDistance) ? nearestDistance : 99;
    out[offset + nC + 4] = nearestIndex;
  }

  /** Probe ids: user probes followed by every person's nose. */
  probeIds(): string[] {
    return [...this.probes.map((probe) => probe.id), ...this.people.people.map((person) => `nose:${person.id}`)];
  }

  sampleAllProbes(out: Float32Array, offset: number): void {
    const stride = this.probeStride;
    let index = 0;
    for (const probe of this.probes) {
      this.sampleProbe(probe.x, probe.y, probe.z, out, offset + index * stride);
      index++;
    }
    for (const person of this.people.people) {
      const nx = person.x + Math.sin(person.yaw) * 0.12;
      const nz = person.z + Math.cos(person.yaw) * 0.12;
      this.sampleProbe(nx, 1.62, nz, out, offset + index * stride);
      index++;
    }
  }

  peopleBuffer(): Float32Array {
    const buffer = new Float32Array(this.people.people.length * PERSON_STRIDE);
    this.people.people.forEach((person, index) => {
      const base = index * PERSON_STRIDE;
      buffer[base] = person.x;
      buffer[base + 1] = person.z;
      buffer[base + 2] = person.yaw;
      buffer[base + 3] = Math.hypot(person.vx, person.vz);
      buffer[base + 4] = person.walkPhase;
      buffer[base + 5] = 0;
    });
    return buffer;
  }

  // ------------------------------------------------------------------ visualization

  /** RGBA volume of the interior cells for ray marching. */
  composite(): Uint8Array {
    const fluid = this.fluid;
    const { nx, ny, nz, sy, sz, solid } = fluid;
    const ix = nx - 2;
    const iy = ny - 2;
    const iz = nz - 2;
    const out = new Uint8Array(ix * iy * iz * 4);
    const settings = this.settings;
    const mode = settings.vizMode;
    const sourceFilter = settings.vizSource;
    const activeSources = this.sources
      .map((source, index) => ({ source, index }))
      .filter(({ source }) => {
        if (source.channels.length === 0) return false;
        if (sourceFilter !== '') return source.info.id === sourceFilter;
        // Bioeffluents come from every person and fill the room by design; show them when soloed.
        return !(mode === 'plume' && source.info.id === 'people');
      });
    // The sealed room fills up over time; subtracting each source's room-average level keeps the
    // plume structure visible instead of a uniform fog.
    const roomVolume = fluid.fluidCount * fluid.cellVolume;
    const background = activeSources.map(({ source }) =>
      settings.subtractBackground && mode !== 'oav' ? source.channels.reduce((sum, channel) => sum + channel.expected, 0) / roomVolume : 0,
    );
    const reference = activeSources.map(({ source }) => {
      const strength = source.item ? Math.max(0.05, source.item.strength) : 1;
      return source.channels.reduce((sum, channel) => sum + channel.headspace, 0) * strength;
    });
    const plumeDecades = Math.max(1, settings.plumeDecades);
    const logMin = settings.ppmLogMin;
    const logRange = Math.max(0.5, settings.ppmLogMax - settings.ppmLogMin);
    const temperature = this.temperature.data;
    const water = this.water.data;
    const ambientT = this.layout.room.ambientTempC;
    const ambientRH = this.layout.room.ambientRH;
    const { u, v, w } = fluid;
    let o = 0;
    for (let k = 1; k <= iz; k++) {
      for (let j = 1; j <= iy; j++) {
        for (let i = 1; i <= ix; i++, o += 4) {
          const idx = i + sy * j + sz * k;
          if (solid[idx]) continue;
          if (mode === 'plume' || mode === 'ppm' || mode === 'oav') {
            let r = 0;
            let g = 0;
            let b = 0;
            let weight = 0;
            let strongest = 0;
            for (let a = 0; a < activeSources.length; a++) {
              const source = activeSources[a].source;
              let concentration = 0;
              let oav = 0;
              for (const channel of source.channels) {
                const value = channel.field.data[idx];
                concentration += value;
                oav += value * channel.oavCoef;
              }
              concentration -= background[a];
              if (concentration <= 1e-12) continue;
              let intensity: number;
              if (mode === 'plume') intensity = (Math.log10(concentration / reference[a]) + plumeDecades) / plumeDecades;
              else if (mode === 'ppm') intensity = (Math.log10(concentration) - logMin) / logRange;
              else intensity = oav > 1 ? Math.log10(oav) / 3.5 : 0;
              if (intensity <= 0) continue;
              if (intensity > 1) intensity = 1;
              const color = source.info.color;
              const weightSquared = intensity * intensity;
              r += color[0] * weightSquared;
              g += color[1] * weightSquared;
              b += color[2] * weightSquared;
              weight += weightSquared;
              if (intensity > strongest) strongest = intensity;
            }
            if (weight > 0) {
              out[o] = Math.min(255, (r / weight) * 255);
              out[o + 1] = Math.min(255, (g / weight) * 255);
              out[o + 2] = Math.min(255, (b / weight) * 255);
              out[o + 3] = strongest * 255;
            }
          } else if (mode === 'temperature') {
            const delta = temperature[idx];
            const intensity = Math.min(1, Math.abs(delta) / 3);
            if (delta > 0) {
              out[o] = 255;
              out[o + 1] = 110 + 100 * (1 - intensity);
              out[o + 2] = 60;
            } else {
              out[o] = 70;
              out[o + 1] = 150;
              out[o + 2] = 255;
            }
            out[o + 3] = intensity * 255;
          } else if (mode === 'humidity') {
            const waterPpm = this.ambientWaterPpm + water[idx];
            const rh = (100 * waterPpm) / saturationWaterPpm(ambientT + temperature[idx]);
            const delta = rh - ambientRH;
            const intensity = Math.min(1, Math.abs(delta) / 12);
            if (delta > 0) {
              out[o] = 60;
              out[o + 1] = 170;
              out[o + 2] = 255;
            } else {
              out[o] = 230;
              out[o + 1] = 190;
              out[o + 2] = 120;
            }
            out[o + 3] = intensity * 255;
          } else {
            const speed = Math.sqrt(u[idx] * u[idx] + v[idx] * v[idx] + w[idx] * w[idx]);
            const t = Math.min(1, speed / 1.5);
            out[o] = 40 + 215 * t;
            out[o + 1] = 120 + 120 * Math.sin(t * Math.PI * 0.9);
            out[o + 2] = 255 * (1 - t);
            out[o + 3] = Math.pow(t, 0.8) * 255;
          }
        }
      }
    }
    return out;
  }

  /** Velocity at every other interior cell, for arrow glyphs. */
  velocitySnapshot(): { data: Float32Array; dims: [number, number, number] } {
    const fluid = this.fluid;
    const dims: [number, number, number] = [
      Math.floor((fluid.nx - 2) / 2),
      Math.floor((fluid.ny - 2) / 2),
      Math.floor((fluid.nz - 2) / 2),
    ];
    const data = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
    let o = 0;
    for (let k = 0; k < dims[2]; k++) {
      for (let j = 0; j < dims[1]; j++) {
        for (let i = 0; i < dims[0]; i++, o += 3) {
          const idx = 1 + 2 * i + fluid.sy * (1 + 2 * j) + fluid.sz * (1 + 2 * k);
          data[o] = fluid.u[idx];
          data[o + 1] = fluid.v[idx];
          data[o + 2] = fluid.w[idx];
        }
      }
    }
    return { data, dims };
  }

  stats(): FrameStats {
    const fluid = this.fluid;
    const stats: FrameStats = {
      sourceIds: this.sources.map((source) => source.info.id),
      emitted: [],
      airborne: [],
      decayed: [],
      filtered: [],
      reservoir: [],
      meanTempC: this.layout.room.ambientTempC + fluid.mean(this.temperature.data),
      meanRH: 0,
      maxSpeed: 0,
    };
    for (const source of this.sources) {
      let emitted = 0;
      let airborne = 0;
      let decayed = 0;
      let filtered = 0;
      for (const channel of source.channels) {
        emitted += channel.emitted;
        airborne += channel.expected;
        decayed += channel.decayed;
        filtered += channel.filtered;
      }
      stats.emitted.push(emitted);
      stats.airborne.push(airborne);
      stats.decayed.push(decayed);
      stats.filtered.push(filtered);
      stats.reservoir.push(source.reservoir);
    }
    const meanWater = this.ambientWaterPpm + fluid.mean(this.water.data);
    stats.meanRH = (100 * meanWater) / saturationWaterPpm(stats.meanTempC);
    let maxSpeed = 0;
    const cells = fluid.fluidCells;
    for (let c = 0; c < cells.length; c += 7) {
      const idx = cells[c];
      const speed = fluid.u[idx] * fluid.u[idx] + fluid.v[idx] * fluid.v[idx] + fluid.w[idx] * fluid.w[idx];
      if (speed > maxSpeed) maxSpeed = speed;
    }
    stats.maxSpeed = Math.sqrt(maxSpeed);
    return stats;
  }

  sourceInfos(): SourceInfo[] {
    return this.sources.map((source) => source.info);
  }

  refill(sourceId: string): void {
    const source = this.sources.find((candidate) => candidate.info.id === sourceId);
    if (source) source.reservoir = 1;
  }

  reset(): void {
    const fluid = this.fluid;
    fluid.u.fill(0);
    fluid.v.fill(0);
    fluid.w.fill(0);
    fluid.p.fill(0);
    this.temperature.data.fill(0);
    this.water.data.fill(0);
    this.waterExpected = 0;
    this.heatExpected = 0;
    for (const source of this.sources) {
      source.reservoir = 1;
      for (const channel of source.channels) {
        channel.field.data.fill(0);
        channel.expected = 0;
        channel.emitted = 0;
        channel.decayed = 0;
        channel.filtered = 0;
      }
    }
    this.time = 0;
    this.particles.count = -1;
    this.particles.configure(this.settings.particleCount, this.settings.particleMode, fluid);
  }
}
