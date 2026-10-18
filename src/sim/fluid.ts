// Incompressible air flow and scalar transport on a collocated voxel grid.
//
// Stable-fluids scheme (Stam 1999) with obstacles:
//   1. semi-Lagrangian advection (RK2 back-trace) of velocity and every scalar, sharing one set
//      of interpolation weights per cell;
//   2. external forces (fans, buoyancy, people, eddies, vorticity confinement) applied by the world;
//   3. pressure projection solved with red-black SOR (Neumann boundaries at solids), with optional
//      volume sources/sinks for recirculating ventilation;
//   4. explicit eddy diffusion of scalars.
// Scalars carry a multiplicative per-step decay factor folded into advection.

import type { Grid } from '../room/voxelize';

export const SOLID_XN = 1;
export const SOLID_XP = 2;
export const SOLID_YN = 4;
export const SOLID_YP = 8;
export const SOLID_ZN = 16;
export const SOLID_ZP = 32;

export interface ScalarField {
  data: Float32Array;
  back: Float32Array;
  decayPerSecond: number; // first-order loss folded into advection
}

export class FluidSim {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  readonly h: number;
  readonly sy: number;
  readonly sz: number;
  readonly cellVolume: number;
  solid: Uint8Array;

  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  private u2: Float32Array;
  private v2: Float32Array;
  private w2: Float32Array;
  p: Float32Array;
  private div: Float32Array;
  divSource: Float32Array; // prescribed divergence (1/s) for ventilation supply (+) / return (-)
  private ox: Float32Array;
  private oy: Float32Array;
  private oz: Float32Array;
  private omag: Float32Array;

  scalars: ScalarField[] = [];

  nbMask!: Uint8Array;
  nFluid!: Uint8Array;
  fluidCells!: Int32Array;
  private cellI!: Int16Array;
  private cellJ!: Int16Array;
  private cellK!: Int16Array;
  private redCells!: Int32Array;
  private blackCells!: Int32Array;
  private ghostCells!: Int32Array;
  private ghostOffsets!: Int32Array;
  private ghostNbs!: Int32Array;
  fluidCount = 0;

  constructor(grid: Grid) {
    this.nx = grid.nx;
    this.ny = grid.ny;
    this.nz = grid.nz;
    this.n = grid.n;
    this.h = grid.h;
    this.sy = grid.nx;
    this.sz = grid.nx * grid.ny;
    this.cellVolume = grid.h * grid.h * grid.h;
    this.solid = grid.solid;
    const n = this.n;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.w = new Float32Array(n);
    this.u2 = new Float32Array(n);
    this.v2 = new Float32Array(n);
    this.w2 = new Float32Array(n);
    this.p = new Float32Array(n);
    this.div = new Float32Array(n);
    this.divSource = new Float32Array(n);
    this.ox = new Float32Array(n);
    this.oy = new Float32Array(n);
    this.oz = new Float32Array(n);
    this.omag = new Float32Array(n);
    this.rebuildTopology();
  }

  /** Replace the solid mask (same dimensions), clearing state inside newly solid cells. */
  setSolid(solid: Uint8Array): void {
    this.solid = solid;
    for (let idx = 0; idx < this.n; idx++) {
      if (!solid[idx]) continue;
      this.u[idx] = 0;
      this.v[idx] = 0;
      this.w[idx] = 0;
      this.u2[idx] = 0;
      this.v2[idx] = 0;
      this.w2[idx] = 0;
      this.p[idx] = 0;
      for (const scalar of this.scalars) scalar.data[idx] = 0;
    }
    this.rebuildTopology();
  }

  private rebuildTopology(): void {
    const { nx, ny, nz, n, sy, sz, solid } = this;
    const nbMask = new Uint8Array(n);
    const nFluid = new Uint8Array(n);
    const fluid: number[] = [];
    const red: number[] = [];
    const black: number[] = [];
    const ghosts: number[] = [];
    const ghostOffsets: number[] = [0];
    const ghostNbs: number[] = [];
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const idx = i + sy * j + sz * k;
          const neighbors = [idx - 1, idx + 1, idx - sy, idx + sy, idx - sz, idx + sz];
          if (solid[idx]) {
            const fluidNeighbors = neighbors.filter((nb) => !solid[nb]);
            if (fluidNeighbors.length > 0) {
              ghosts.push(idx);
              ghostNbs.push(...fluidNeighbors);
              ghostOffsets.push(ghostNbs.length);
            }
            continue;
          }
          let mask = 0;
          let count = 0;
          neighbors.forEach((nb, bit) => {
            if (solid[nb]) mask |= 1 << bit;
            else count++;
          });
          nbMask[idx] = mask;
          nFluid[idx] = count;
          fluid.push(idx);
          if ((i + j + k) % 2 === 0) red.push(idx);
          else black.push(idx);
        }
      }
    }
    // Border cells adjacent to the interior also act as ghosts for interpolation.
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (i > 0 && j > 0 && k > 0 && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
          const idx = i + sy * j + sz * k;
          const fluidNeighbors: number[] = [];
          if (i > 0 && !solid[idx - 1]) fluidNeighbors.push(idx - 1);
          if (i < nx - 1 && !solid[idx + 1]) fluidNeighbors.push(idx + 1);
          if (j > 0 && !solid[idx - sy]) fluidNeighbors.push(idx - sy);
          if (j < ny - 1 && !solid[idx + sy]) fluidNeighbors.push(idx + sy);
          if (k > 0 && !solid[idx - sz]) fluidNeighbors.push(idx - sz);
          if (k < nz - 1 && !solid[idx + sz]) fluidNeighbors.push(idx + sz);
          if (fluidNeighbors.length > 0) {
            ghosts.push(idx);
            ghostNbs.push(...fluidNeighbors);
            ghostOffsets.push(ghostNbs.length);
          }
        }
      }
    }
    this.nbMask = nbMask;
    this.nFluid = nFluid;
    this.fluidCells = Int32Array.from(fluid);
    this.fluidCount = fluid.length;
    this.redCells = Int32Array.from(red);
    this.blackCells = Int32Array.from(black);
    this.ghostCells = Int32Array.from(ghosts);
    this.ghostOffsets = Int32Array.from(ghostOffsets);
    this.ghostNbs = Int32Array.from(ghostNbs);
    this.cellI = new Int16Array(fluid.length);
    this.cellJ = new Int16Array(fluid.length);
    this.cellK = new Int16Array(fluid.length);
    for (let c = 0; c < fluid.length; c++) {
      const idx = fluid[c];
      const k = Math.floor(idx / sz);
      const rem = idx - k * sz;
      const j = Math.floor(rem / sy);
      this.cellI[c] = rem - j * sy;
      this.cellJ[c] = j;
      this.cellK[c] = k;
    }
  }

  addScalar(decayPerSecond = 0, initial?: Float32Array): ScalarField {
    const field: ScalarField = {
      data: initial ?? new Float32Array(this.n),
      back: new Float32Array(this.n),
      decayPerSecond,
    };
    this.scalars.push(field);
    return field;
  }

  removeScalar(field: ScalarField): void {
    this.scalars = this.scalars.filter((candidate) => candidate !== field);
  }

  /** Copy each solid boundary cell's value from the mean of its fluid neighbors. */
  private ghostFill(field: Float32Array): void {
    const { ghostCells, ghostOffsets, ghostNbs } = this;
    for (let g = 0; g < ghostCells.length; g++) {
      const start = ghostOffsets[g];
      const end = ghostOffsets[g + 1];
      let sum = 0;
      for (let m = start; m < end; m++) sum += field[ghostNbs[m]];
      field[ghostCells[g]] = sum / (end - start);
    }
  }

  /** Semi-Lagrangian advection of velocity and all scalars with the current velocity field. */
  advect(dt: number): void {
    for (const scalar of this.scalars) this.ghostFill(scalar.data);
    const { sy, sz, u, v, w, fluidCells, cellI, cellJ, cellK } = this;
    const maxX = this.nx - 2;
    const maxY = this.ny - 2;
    const maxZ = this.nz - 2;
    const scale = dt / this.h;
    const nScalars = this.scalars.length;
    const src: Float32Array[] = [];
    const dst: Float32Array[] = [];
    const decay = new Float32Array(nScalars);
    for (let s = 0; s < nScalars; s++) {
      src.push(this.scalars[s].data);
      dst.push(this.scalars[s].back);
      decay[s] = Math.exp(-this.scalars[s].decayPerSecond * dt);
    }
    const u2 = this.u2;
    const v2 = this.v2;
    const w2 = this.w2;
    const count = fluidCells.length;
    for (let c = 0; c < count; c++) {
      const idx = fluidCells[c];
      const i = cellI[c];
      const j = cellJ[c];
      const k = cellK[c];
      // RK2 midpoint
      let x = i - 0.5 * scale * u[idx];
      let y = j - 0.5 * scale * v[idx];
      let z = k - 0.5 * scale * w[idx];
      x = x < 1 ? 1 : x > maxX ? maxX : x;
      y = y < 1 ? 1 : y > maxY ? maxY : y;
      z = z < 1 ? 1 : z > maxZ ? maxZ : z;
      let i0 = x | 0;
      let j0 = y | 0;
      let k0 = z | 0;
      let fx = x - i0;
      let fy = y - j0;
      let fz = z - k0;
      let b = i0 + sy * j0 + sz * k0;
      let w000 = (1 - fx) * (1 - fy) * (1 - fz);
      let w100 = fx * (1 - fy) * (1 - fz);
      let w010 = (1 - fx) * fy * (1 - fz);
      let w110 = fx * fy * (1 - fz);
      let w001 = (1 - fx) * (1 - fy) * fz;
      let w101 = fx * (1 - fy) * fz;
      let w011 = (1 - fx) * fy * fz;
      let w111 = fx * fy * fz;
      const um =
        w000 * u[b] + w100 * u[b + 1] + w010 * u[b + sy] + w110 * u[b + sy + 1] +
        w001 * u[b + sz] + w101 * u[b + sz + 1] + w011 * u[b + sy + sz] + w111 * u[b + sy + sz + 1];
      const vm =
        w000 * v[b] + w100 * v[b + 1] + w010 * v[b + sy] + w110 * v[b + sy + 1] +
        w001 * v[b + sz] + w101 * v[b + sz + 1] + w011 * v[b + sy + sz] + w111 * v[b + sy + sz + 1];
      const wm =
        w000 * w[b] + w100 * w[b + 1] + w010 * w[b + sy] + w110 * w[b + sy + 1] +
        w001 * w[b + sz] + w101 * w[b + sz + 1] + w011 * w[b + sy + sz] + w111 * w[b + sy + sz + 1];
      x = i - scale * um;
      y = j - scale * vm;
      z = k - scale * wm;
      x = x < 1 ? 1 : x > maxX ? maxX : x;
      y = y < 1 ? 1 : y > maxY ? maxY : y;
      z = z < 1 ? 1 : z > maxZ ? maxZ : z;
      i0 = x | 0;
      j0 = y | 0;
      k0 = z | 0;
      fx = x - i0;
      fy = y - j0;
      fz = z - k0;
      b = i0 + sy * j0 + sz * k0;
      w000 = (1 - fx) * (1 - fy) * (1 - fz);
      w100 = fx * (1 - fy) * (1 - fz);
      w010 = (1 - fx) * fy * (1 - fz);
      w110 = fx * fy * (1 - fz);
      w001 = (1 - fx) * (1 - fy) * fz;
      w101 = fx * (1 - fy) * fz;
      w011 = (1 - fx) * fy * fz;
      w111 = fx * fy * fz;
      const b1 = b + 1;
      const b2 = b + sy;
      const b3 = b + sy + 1;
      const b4 = b + sz;
      const b5 = b + sz + 1;
      const b6 = b + sy + sz;
      const b7 = b + sy + sz + 1;
      u2[idx] = w000 * u[b] + w100 * u[b1] + w010 * u[b2] + w110 * u[b3] + w001 * u[b4] + w101 * u[b5] + w011 * u[b6] + w111 * u[b7];
      v2[idx] = w000 * v[b] + w100 * v[b1] + w010 * v[b2] + w110 * v[b3] + w001 * v[b4] + w101 * v[b5] + w011 * v[b6] + w111 * v[b7];
      w2[idx] = w000 * w[b] + w100 * w[b1] + w010 * w[b2] + w110 * w[b3] + w001 * w[b4] + w101 * w[b5] + w011 * w[b6] + w111 * w[b7];
      for (let s = 0; s < nScalars; s++) {
        const f = src[s];
        dst[s][idx] =
          decay[s] *
          (w000 * f[b] + w100 * f[b1] + w010 * f[b2] + w110 * f[b3] + w001 * f[b4] + w101 * f[b5] + w011 * f[b6] + w111 * f[b7]);
      }
    }
    this.u2 = u;
    this.v2 = v;
    this.w2 = w;
    this.u = u2;
    this.v = v2;
    this.w = w2;
    for (const scalar of this.scalars) {
      const tmp = scalar.data;
      scalar.data = scalar.back;
      scalar.back = tmp;
    }
  }

  /** Pressure projection: make the velocity field divergence-free (except prescribed sources). */
  project(iterations: number): void {
    const { u, v, w, p, div, divSource, nbMask, nFluid, fluidCells, sy, sz, h } = this;
    const inv2h = 1 / (2 * h);
    for (let c = 0; c < fluidCells.length; c++) {
      const idx = fluidCells[c];
      const m = nbMask[idx];
      const uR = m & SOLID_XP ? 0 : u[idx + 1];
      const uL = m & SOLID_XN ? 0 : u[idx - 1];
      const vU = m & SOLID_YP ? 0 : v[idx + sy];
      const vD = m & SOLID_YN ? 0 : v[idx - sy];
      const wF = m & SOLID_ZP ? 0 : w[idx + sz];
      const wB = m & SOLID_ZN ? 0 : w[idx - sz];
      div[idx] = (uR - uL + vU - vD + wF - wB) * inv2h - divSource[idx];
    }
    const h2 = h * h;
    const omega = 1.75;
    const sweep = (cells: Int32Array) => {
      for (let c = 0; c < cells.length; c++) {
        const idx = cells[c];
        const m = nbMask[idx];
        const count = nFluid[idx];
        if (count === 0) continue;
        let sum = 0;
        if (!(m & SOLID_XN)) sum += p[idx - 1];
        if (!(m & SOLID_XP)) sum += p[idx + 1];
        if (!(m & SOLID_YN)) sum += p[idx - sy];
        if (!(m & SOLID_YP)) sum += p[idx + sy];
        if (!(m & SOLID_ZN)) sum += p[idx - sz];
        if (!(m & SOLID_ZP)) sum += p[idx + sz];
        const target = (sum - h2 * div[idx]) / count;
        p[idx] += omega * (target - p[idx]);
      }
    };
    for (let it = 0; it < iterations; it++) {
      sweep(this.redCells);
      sweep(this.blackCells);
    }
    for (let c = 0; c < fluidCells.length; c++) {
      const idx = fluidCells[c];
      const m = nbMask[idx];
      const pc = p[idx];
      const pR = m & SOLID_XP ? pc : p[idx + 1];
      const pL = m & SOLID_XN ? pc : p[idx - 1];
      const pU = m & SOLID_YP ? pc : p[idx + sy];
      const pD = m & SOLID_YN ? pc : p[idx - sy];
      const pF = m & SOLID_ZP ? pc : p[idx + sz];
      const pB = m & SOLID_ZN ? pc : p[idx - sz];
      let uu = u[idx] - (pR - pL) * inv2h;
      let vv = v[idx] - (pU - pD) * inv2h;
      let ww = w[idx] - (pF - pB) * inv2h;
      // no flow into walls
      if (m & SOLID_XP && uu > 0) uu = 0;
      if (m & SOLID_XN && uu < 0) uu = 0;
      if (m & SOLID_YP && vv > 0) vv = 0;
      if (m & SOLID_YN && vv < 0) vv = 0;
      if (m & SOLID_ZP && ww > 0) ww = 0;
      if (m & SOLID_ZN && ww < 0) ww = 0;
      u[idx] = uu;
      v[idx] = vv;
      w[idx] = ww;
    }
  }

  /** Vorticity confinement: re-inject small-scale swirl lost to numerical dissipation. */
  confineVorticity(strength: number, dt: number): void {
    if (strength <= 0) return;
    const { u, v, w, ox, oy, oz, omag, nbMask, fluidCells, sy, sz, h } = this;
    const inv2h = 1 / (2 * h);
    for (let c = 0; c < fluidCells.length; c++) {
      const idx = fluidCells[c];
      const m = nbMask[idx];
      const uU = m & SOLID_YP ? 0 : u[idx + sy];
      const uD = m & SOLID_YN ? 0 : u[idx - sy];
      const uF = m & SOLID_ZP ? 0 : u[idx + sz];
      const uB = m & SOLID_ZN ? 0 : u[idx - sz];
      const vR = m & SOLID_XP ? 0 : v[idx + 1];
      const vL = m & SOLID_XN ? 0 : v[idx - 1];
      const vF = m & SOLID_ZP ? 0 : v[idx + sz];
      const vB = m & SOLID_ZN ? 0 : v[idx - sz];
      const wR = m & SOLID_XP ? 0 : w[idx + 1];
      const wL = m & SOLID_XN ? 0 : w[idx - 1];
      const wU = m & SOLID_YP ? 0 : w[idx + sy];
      const wD = m & SOLID_YN ? 0 : w[idx - sy];
      const cx = (wU - wD - (vF - vB)) * inv2h;
      const cy = (uF - uB - (wR - wL)) * inv2h;
      const cz = (vR - vL - (uU - uD)) * inv2h;
      ox[idx] = cx;
      oy[idx] = cy;
      oz[idx] = cz;
      omag[idx] = Math.sqrt(cx * cx + cy * cy + cz * cz);
    }
    const scale = strength * h * dt;
    for (let c = 0; c < fluidCells.length; c++) {
      const idx = fluidCells[c];
      const m = nbMask[idx];
      const mc = omag[idx];
      const gx = ((m & SOLID_XP ? mc : omag[idx + 1]) - (m & SOLID_XN ? mc : omag[idx - 1])) * inv2h;
      const gy = ((m & SOLID_YP ? mc : omag[idx + sy]) - (m & SOLID_YN ? mc : omag[idx - sy])) * inv2h;
      const gz = ((m & SOLID_ZP ? mc : omag[idx + sz]) - (m & SOLID_ZN ? mc : omag[idx - sz])) * inv2h;
      const len = Math.sqrt(gx * gx + gy * gy + gz * gz) + 1e-6;
      const nx = gx / len;
      const ny = gy / len;
      const nz = gz / len;
      u[idx] += scale * (ny * oz[idx] - nz * oy[idx]);
      v[idx] += scale * (nz * ox[idx] - nx * oz[idx]);
      w[idx] += scale * (nx * oy[idx] - ny * ox[idx]);
    }
  }

  /** Explicit diffusion of a scalar with zero-flux walls. */
  diffuse(field: ScalarField, diffusivity: number, dt: number): void {
    if (diffusivity <= 0) return;
    const alphaTotal = (diffusivity * dt) / (this.h * this.h);
    const substeps = Math.max(1, Math.ceil(alphaTotal / 0.15));
    const alpha = alphaTotal / substeps;
    const { nbMask, nFluid, fluidCells, sy, sz } = this;
    for (let step = 0; step < substeps; step++) {
      const src = field.data;
      const dst = field.back;
      for (let c = 0; c < fluidCells.length; c++) {
        const idx = fluidCells[c];
        const m = nbMask[idx];
        const center = src[idx];
        let sum = 0;
        if (!(m & SOLID_XN)) sum += src[idx - 1];
        if (!(m & SOLID_XP)) sum += src[idx + 1];
        if (!(m & SOLID_YN)) sum += src[idx - sy];
        if (!(m & SOLID_YP)) sum += src[idx + sy];
        if (!(m & SOLID_ZN)) sum += src[idx - sz];
        if (!(m & SOLID_ZP)) sum += src[idx + sz];
        dst[idx] = center + alpha * (sum - nFluid[idx] * center);
      }
      field.data = dst;
      field.back = src;
    }
  }

  /** Sum of a scalar over fluid cells (multiply by cellVolume for an integral). */
  total(field: Float32Array): number {
    const { fluidCells } = this;
    let sum = 0;
    for (let c = 0; c < fluidCells.length; c++) sum += field[fluidCells[c]];
    return sum;
  }

  scale(field: Float32Array, factor: number): void {
    const { fluidCells } = this;
    for (let c = 0; c < fluidCells.length; c++) field[fluidCells[c]] *= factor;
  }

  mean(field: Float32Array): number {
    return this.fluidCount > 0 ? this.total(field) / this.fluidCount : 0;
  }

  /** Index-space coordinates for a world position. */
  toGrid(x: number, y: number, z: number): [number, number, number] {
    return [x / this.h + 0.5, y / this.h + 0.5, z / this.h + 0.5];
  }

  /** Trilinear sample of a field at a world position, ignoring solid corners. */
  sampleFluid(field: Float32Array, x: number, y: number, z: number): number {
    const { sy, sz, solid } = this;
    let gx = x / this.h + 0.5;
    let gy = y / this.h + 0.5;
    let gz = z / this.h + 0.5;
    gx = Math.min(this.nx - 2, Math.max(1, gx));
    gy = Math.min(this.ny - 2, Math.max(1, gy));
    gz = Math.min(this.nz - 2, Math.max(1, gz));
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const k0 = Math.floor(gz);
    const fx = gx - i0;
    const fy = gy - j0;
    const fz = gz - k0;
    let sum = 0;
    let weight = 0;
    for (let dk = 0; dk < 2; dk++) {
      const wz = dk ? fz : 1 - fz;
      for (let dj = 0; dj < 2; dj++) {
        const wy = dj ? fy : 1 - fy;
        for (let di = 0; di < 2; di++) {
          const wx = di ? fx : 1 - fx;
          const idx = i0 + di + sy * (j0 + dj) + sz * (k0 + dk);
          if (solid[idx]) continue;
          const wgt = wx * wy * wz;
          sum += wgt * field[idx];
          weight += wgt;
        }
      }
    }
    return weight > 1e-6 ? sum / weight : 0;
  }

  /** Trilinear velocity sample (solid cells have zero velocity). */
  sampleVelocity(x: number, y: number, z: number, out: Float32Array | number[]): void {
    const { sy, sz, u, v, w } = this;
    let gx = x / this.h + 0.5;
    let gy = y / this.h + 0.5;
    let gz = z / this.h + 0.5;
    gx = Math.min(this.nx - 2, Math.max(1, gx));
    gy = Math.min(this.ny - 2, Math.max(1, gy));
    gz = Math.min(this.nz - 2, Math.max(1, gz));
    const i0 = gx | 0;
    const j0 = gy | 0;
    const k0 = gz | 0;
    const fx = gx - i0;
    const fy = gy - j0;
    const fz = gz - k0;
    const b = i0 + sy * j0 + sz * k0;
    const w000 = (1 - fx) * (1 - fy) * (1 - fz);
    const w100 = fx * (1 - fy) * (1 - fz);
    const w010 = (1 - fx) * fy * (1 - fz);
    const w110 = fx * fy * (1 - fz);
    const w001 = (1 - fx) * (1 - fy) * fz;
    const w101 = fx * (1 - fy) * fz;
    const w011 = (1 - fx) * fy * fz;
    const w111 = fx * fy * fz;
    out[0] = w000 * u[b] + w100 * u[b + 1] + w010 * u[b + sy] + w110 * u[b + sy + 1] + w001 * u[b + sz] + w101 * u[b + sz + 1] + w011 * u[b + sy + sz] + w111 * u[b + sy + sz + 1];
    out[1] = w000 * v[b] + w100 * v[b + 1] + w010 * v[b + sy] + w110 * v[b + sy + 1] + w001 * v[b + sz] + w101 * v[b + sz + 1] + w011 * v[b + sy + sz] + w111 * v[b + sy + sz + 1];
    out[2] = w000 * w[b] + w100 * w[b + 1] + w010 * w[b + sy] + w110 * w[b + sy + 1] + w001 * w[b + sz] + w101 * w[b + sz + 1] + w011 * w[b + sy + sz] + w111 * w[b + sy + sz + 1];
  }

  isSolidAt(x: number, y: number, z: number): boolean {
    const i = Math.floor(x / this.h + 1);
    const j = Math.floor(y / this.h + 1);
    const k = Math.floor(z / this.h + 1);
    if (i < 1 || j < 1 || k < 1 || i > this.nx - 2 || j > this.ny - 2 || k > this.nz - 2) return true;
    return this.solid[i + this.sy * j + this.sz * k] === 1;
  }

  cellIndexAt(x: number, y: number, z: number): number {
    const i = Math.min(this.nx - 2, Math.max(1, Math.floor(x / this.h + 1)));
    const j = Math.min(this.ny - 2, Math.max(1, Math.floor(y / this.h + 1)));
    const k = Math.min(this.nz - 2, Math.max(1, Math.floor(z / this.h + 1)));
    return i + this.sy * j + this.sz * k;
  }

  /** World-space center of a cell index. */
  cellCenter(idx: number): [number, number, number] {
    const k = Math.floor(idx / this.sz);
    const rem = idx - k * this.sz;
    const j = Math.floor(rem / this.sy);
    const i = rem - j * this.sy;
    return [(i - 0.5) * this.h, (j - 0.5) * this.h, (k - 0.5) * this.h];
  }
}
