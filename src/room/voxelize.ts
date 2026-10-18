// Converts a room layout into a voxel grid shared by the fluid solver and the main thread.
//
// The grid includes a 1-cell solid border so that the closed room walls never need bounds
// checks. Cell (i, j, k) has its center at world ((i - 0.5) h, (j - 0.5) h, (k - 0.5) h).

import type { BlockItem, GridInfo, Item, Layout, PillarItem, PurifierItem, TableItem } from '../types';

export interface Grid extends GridInfo {
  n: number;
  solid: Uint8Array;
}

export const TABLE_THICKNESS = 0.05;
export const PURIFIER_SIZE: [number, number, number] = [0.36, 0.7, 0.36];

export function gridDims(layout: Layout): GridInfo {
  const { width, depth, height, cellSize } = layout.room;
  const nx = Math.max(4, Math.round(width / cellSize)) + 2;
  const ny = Math.max(4, Math.round(height / cellSize)) + 2;
  const nz = Math.max(4, Math.round(depth / cellSize)) + 2;
  return {
    nx,
    ny,
    nz,
    h: cellSize,
    roomSize: [(nx - 2) * cellSize, (ny - 2) * cellSize, (nz - 2) * cellSize],
  };
}

/** Snap room dimensions to whole cells so the volume texture maps exactly onto the room. */
export function snapRoom(layout: Layout): void {
  const dims = gridDims(layout);
  layout.room.width = dims.roomSize[0];
  layout.room.height = dims.roomSize[1];
  layout.room.depth = dims.roomSize[2];
}

interface OrientedBox {
  cx: number;
  cz: number;
  y0: number;
  y1: number;
  hw: number; // half extent along local x
  hd: number; // half extent along local z
  cos: number;
  sin: number;
}

interface Cylinder {
  cx: number;
  cz: number;
  radius: number;
  y0: number;
  y1: number;
}

/** Solid boxes for an item, in world space. Thin parts are thickened to at least one cell. */
export function solidBoxes(item: Item, h: number): OrientedBox[] {
  const minHalf = h * 0.5;
  const rotated = Math.abs(Math.sin(2 * item.yaw)) > 0.01;
  const thin = rotated ? h * 0.75 : minHalf;
  const box = (cx: number, cz: number, w: number, d: number, y0: number, y1: number, yaw: number): OrientedBox => {
    const midY = (y0 + y1) / 2;
    const halfY = Math.max((y1 - y0) / 2, minHalf);
    return {
      cx,
      cz,
      y0: midY - halfY,
      y1: midY + halfY,
      hw: Math.max(w / 2, thin),
      hd: Math.max(d / 2, thin),
      cos: Math.cos(yaw),
      sin: Math.sin(yaw),
    };
  };
  switch (item.type) {
    case 'block': {
      const block = item as BlockItem;
      return [box(block.x, block.z, block.w, block.d, block.y, block.y + block.h, block.yaw)];
    }
    case 'table': {
      const table = item as TableItem;
      return [box(table.x, table.z, table.w, table.d, table.h - TABLE_THICKNESS, table.h, table.yaw)];
    }
    case 'heater':
      return [box(item.x, item.z, item.w, item.d, 0.1, 0.1 + item.h, item.yaw)];
    case 'purifier': {
      const purifier = item as PurifierItem;
      const [w, hh, d] = PURIFIER_SIZE;
      return [box(purifier.x, purifier.z, w * 0.7, d * 0.7, 0.15, hh - 0.1, purifier.yaw)];
    }
    default:
      return [];
  }
}

function solidCylinders(item: Item, h: number): Cylinder[] {
  if (item.type !== 'pillar') return [];
  const pillar = item as PillarItem;
  return [{ cx: pillar.x, cz: pillar.z, radius: Math.max(pillar.radius, h * 0.5), y0: 0, y1: pillar.h }];
}

export function buildGrid(layout: Layout): Grid {
  const dims = gridDims(layout);
  const { nx, ny, nz, h } = dims;
  const n = nx * ny * nz;
  const solid = new Uint8Array(n);

  // Closed room: border cells are walls, floor and ceiling.
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) {
          solid[i + nx * (j + ny * k)] = 1;
        }
      }
    }
  }

  const toIndex = (world: number) => world / h + 0.5;
  for (const item of layout.items) {
    for (const b of solidBoxes(item, h)) {
      const reach = Math.hypot(b.hw, b.hd);
      const i0 = Math.max(1, Math.floor(toIndex(b.cx - reach)));
      const i1 = Math.min(nx - 2, Math.ceil(toIndex(b.cx + reach)));
      const k0 = Math.max(1, Math.floor(toIndex(b.cz - reach)));
      const k1 = Math.min(nz - 2, Math.ceil(toIndex(b.cz + reach)));
      const j0 = Math.max(1, Math.floor(toIndex(b.y0)));
      const j1 = Math.min(ny - 2, Math.ceil(toIndex(b.y1)));
      for (let k = k0; k <= k1; k++) {
        const wz = (k - 0.5) * h - b.cz;
        for (let i = i0; i <= i1; i++) {
          const wx = (i - 0.5) * h - b.cx;
          // world -> local (inverse yaw rotation about +y)
          const lx = wx * b.cos - wz * b.sin;
          const lz = wx * b.sin + wz * b.cos;
          if (Math.abs(lx) > b.hw || Math.abs(lz) > b.hd) continue;
          for (let j = j0; j <= j1; j++) {
            const wy = (j - 0.5) * h;
            if (wy < b.y0 || wy > b.y1) continue;
            solid[i + nx * (j + ny * k)] = 1;
          }
        }
      }
    }
    for (const cyl of solidCylinders(item, h)) {
      const i0 = Math.max(1, Math.floor(toIndex(cyl.cx - cyl.radius)));
      const i1 = Math.min(nx - 2, Math.ceil(toIndex(cyl.cx + cyl.radius)));
      const k0 = Math.max(1, Math.floor(toIndex(cyl.cz - cyl.radius)));
      const k1 = Math.min(nz - 2, Math.ceil(toIndex(cyl.cz + cyl.radius)));
      const j1 = Math.min(ny - 2, Math.ceil(toIndex(cyl.y1)));
      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          const dx = (i - 0.5) * h - cyl.cx;
          const dz = (k - 0.5) * h - cyl.cz;
          if (dx * dx + dz * dz > cyl.radius * cyl.radius) continue;
          for (let j = 1; j <= j1; j++) solid[i + nx * (j + ny * k)] = 1;
        }
      }
    }
  }
  return { ...dims, n, solid };
}

/** Cell index containing a world position (clamped into the interior). */
export function cellOf(grid: GridInfo, x: number, y: number, z: number): [number, number, number] {
  const clamp = (value: number, max: number) => Math.min(max - 2, Math.max(1, value));
  return [
    clamp(Math.floor(x / grid.h + 1), grid.nx),
    clamp(Math.floor(y / grid.h + 1), grid.ny),
    clamp(Math.floor(z / grid.h + 1), grid.nz),
  ];
}

/**
 * 2D walkability map (nx * nz) for people: a column is walkable if it is free from the floor up
 * to head height, with one cell of clearance from obstacles.
 */
export function buildWalkable(grid: Grid, headHeight = 1.8): Uint8Array {
  const { nx, ny, nz, h, solid } = grid;
  const free = new Uint8Array(nx * nz);
  const jTop = Math.min(ny - 2, Math.ceil(headHeight / h));
  for (let k = 1; k < nz - 1; k++) {
    for (let i = 1; i < nx - 1; i++) {
      let open = 1;
      for (let j = 1; j <= jTop; j++) {
        if (solid[i + nx * (j + ny * k)]) {
          open = 0;
          break;
        }
      }
      free[i + nx * k] = open;
    }
  }
  const clearanceCells = h <= 0.2 ? 1 : 0;
  if (clearanceCells === 0) return free;
  const walkable = new Uint8Array(nx * nz);
  for (let k = 1; k < nz - 1; k++) {
    for (let i = 1; i < nx - 1; i++) {
      if (!free[i + nx * k]) continue;
      let ok = 1;
      for (let dk = -1; dk <= 1 && ok; dk++) {
        for (let di = -1; di <= 1; di++) {
          if (!free[i + di + nx * (k + dk)]) {
            ok = 0;
            break;
          }
        }
      }
      walkable[i + nx * k] = ok;
    }
  }
  return walkable;
}

/** Height of the top surface under (x, z), used to rest objects on tables and shelves. */
export function surfaceHeightAt(layout: Layout, x: number, z: number, ignoreId?: string): number {
  let top = 0;
  for (const item of layout.items) {
    if (item.id === ignoreId) continue;
    let w = 0;
    let d = 0;
    let height = 0;
    if (item.type === 'table') {
      w = item.w;
      d = item.d;
      height = item.h;
    } else if (item.type === 'block' && item.kind !== 'wall' && item.kind !== 'partition') {
      w = item.w;
      d = item.d;
      height = item.y + item.h;
    } else if (item.type === 'heater') {
      w = item.w;
      d = item.d;
      height = item.h + 0.1;
    } else {
      continue;
    }
    const dx = x - item.x;
    const dz = z - item.z;
    const cos = Math.cos(item.yaw);
    const sin = Math.sin(item.yaw);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    if (Math.abs(lx) <= w / 2 && Math.abs(lz) <= d / 2) top = Math.max(top, height);
  }
  return top;
}

/** Surface area to volume ratio of the room, including furniture surfaces (1/m). */
export function areaToVolume(layout: Layout): number {
  const { width, depth, height } = layout.room;
  let area = 2 * (width * depth + width * height + depth * height);
  for (const item of layout.items) {
    if (item.type === 'block') area += 2 * (item.w * item.d + item.w * item.h + item.d * item.h);
    else if (item.type === 'table') area += 2 * item.w * item.d;
    else if (item.type === 'pillar') area += 2 * Math.PI * item.radius * item.h;
  }
  return area / (width * depth * height);
}
