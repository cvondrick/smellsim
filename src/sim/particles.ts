// Lagrangian tracer particles for visualization.
//
// 'odor' mode: particles are released at sources in proportion to emission and carried by the
// resolved air velocity plus a random walk standing in for unresolved turbulence. They reveal the
// filamentous, intermittent structure of plumes. 'air' mode: particles fill the room and trace
// the air currents, colored by speed.

import type { FluidSim } from './fluid';
import type { ParticleMode } from '../types';

export interface ParticleEmitter {
  sourceIndex: number;
  rate: number; // relative release weight (>= 0)
  x: number;
  y: number;
  z: number;
  spreadX: number;
  spreadY: number;
  spreadZ: number;
}

const ODOR_LIFETIME = 120; // s
const AIR_LIFETIME = 10; // s

export class Particles {
  count = 0;
  mode: ParticleMode = 'odor';
  positions = new Float32Array(0);
  attributes = new Float32Array(0); // odor: sourceIndex + ageFraction*0.999, air: speed, hidden: -1
  private ages = new Float32Array(0);
  private lifetimes = new Float32Array(0);
  private sources = new Int16Array(0);
  private cursor = 0;
  private spawnAccumulator = 0;
  private readonly velocity = new Float32Array(3);
  private random: () => number;

  constructor(random: () => number) {
    this.random = random;
  }

  configure(count: number, mode: ParticleMode, fluid: FluidSim): void {
    if (count === this.count && mode === this.mode) return;
    this.count = count;
    this.mode = mode;
    this.positions = new Float32Array(count * 3);
    this.attributes = new Float32Array(count).fill(-1);
    this.ages = new Float32Array(count);
    this.lifetimes = new Float32Array(count);
    this.sources = new Int16Array(count).fill(-1);
    this.cursor = 0;
    if (mode === 'air') for (let index = 0; index < count; index++) this.respawnAir(index, fluid, true);
  }

  private gaussian(): number {
    const u1 = Math.max(1e-9, this.random());
    const u2 = this.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  private respawnAir(index: number, fluid: FluidSim, randomAge: boolean): void {
    const cells = fluid.fluidCells;
    const idx = cells[Math.floor(this.random() * cells.length)];
    const [cx, cy, cz] = fluid.cellCenter(idx);
    const h = fluid.h;
    this.positions[index * 3] = cx + (this.random() - 0.5) * h;
    this.positions[index * 3 + 1] = cy + (this.random() - 0.5) * h;
    this.positions[index * 3 + 2] = cz + (this.random() - 0.5) * h;
    this.lifetimes[index] = AIR_LIFETIME * (0.6 + 0.8 * this.random());
    this.ages[index] = randomAge ? this.random() * this.lifetimes[index] : 0;
  }

  update(dt: number, fluid: FluidSim, emitters: ParticleEmitter[], diffusivity: number): void {
    if (this.mode === 'off' || this.count === 0) return;
    const { positions, attributes, ages, lifetimes, velocity } = this;

    if (this.mode === 'odor') {
      const totalRate = emitters.reduce((sum, emitter) => sum + emitter.rate, 0);
      if (totalRate > 0) {
        this.spawnAccumulator += (this.count / ODOR_LIFETIME) * dt;
        let toSpawn = Math.floor(this.spawnAccumulator);
        this.spawnAccumulator -= toSpawn;
        while (toSpawn-- > 0) {
          let pick = this.random() * totalRate;
          let emitter = emitters[0];
          for (const candidate of emitters) {
            pick -= candidate.rate;
            if (pick <= 0) {
              emitter = candidate;
              break;
            }
          }
          const index = this.cursor;
          this.cursor = (this.cursor + 1) % this.count;
          positions[index * 3] = emitter.x + (this.random() - 0.5) * emitter.spreadX;
          positions[index * 3 + 1] = emitter.y + this.random() * emitter.spreadY;
          positions[index * 3 + 2] = emitter.z + (this.random() - 0.5) * emitter.spreadZ;
          ages[index] = 0;
          lifetimes[index] = ODOR_LIFETIME * (0.5 + this.random());
          this.sources[index] = emitter.sourceIndex;
        }
      }
    }

    const walk = Math.sqrt(2 * (0.002 + diffusivity) * dt);
    for (let index = 0; index < this.count; index++) {
      if (this.mode === 'odor' && this.sources[index] < 0) {
        attributes[index] = -1;
        continue;
      }
      ages[index] += dt;
      if (ages[index] > lifetimes[index]) {
        if (this.mode === 'air') {
          this.respawnAir(index, fluid, false);
        } else {
          this.sources[index] = -1;
          attributes[index] = -1;
          continue;
        }
      }
      const px = positions[index * 3];
      const py = positions[index * 3 + 1];
      const pz = positions[index * 3 + 2];
      fluid.sampleVelocity(px, py, pz, velocity);
      const nx = px + velocity[0] * dt + walk * this.gaussian();
      const ny = py + velocity[1] * dt + walk * this.gaussian();
      const nz = pz + velocity[2] * dt + walk * this.gaussian();
      if (!fluid.isSolidAt(nx, ny, nz)) {
        positions[index * 3] = nx;
        positions[index * 3 + 1] = ny;
        positions[index * 3 + 2] = nz;
      } else {
        // slide along whichever axes are free
        if (!fluid.isSolidAt(nx, py, pz)) positions[index * 3] = nx;
        if (!fluid.isSolidAt(positions[index * 3], ny, pz)) positions[index * 3 + 1] = ny;
        if (!fluid.isSolidAt(positions[index * 3], positions[index * 3 + 1], nz)) positions[index * 3 + 2] = nz;
      }
      if (this.mode === 'air') {
        attributes[index] = Math.hypot(velocity[0], velocity[1], velocity[2]) + 0.001;
      } else {
        attributes[index] = this.sources[index] + Math.min(0.999, ages[index] / lifetimes[index]);
      }
    }
  }
}
