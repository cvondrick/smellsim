// People walking around the room on a 2D navigation grid (A* path finding).

import type { PersonItem } from '../types';

export interface PersonState {
  id: string;
  item: PersonItem;
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  walkPhase: number;
  path: number[]; // nav cell indices
  pathIndex: number;
  waitUntil: number;
  spawnX: number;
  spawnZ: number;
}

export class PeopleSim {
  people: PersonState[] = [];
  private walkable: Uint8Array;
  private nx: number;
  private nz: number;
  private h: number;
  private walkableCells: number[] = [];
  private pointsOfInterest: [number, number][] = [];
  private random: () => number;

  constructor(walkable: Uint8Array, nx: number, nz: number, h: number, random: () => number) {
    this.walkable = walkable;
    this.nx = nx;
    this.nz = nz;
    this.h = h;
    this.random = random;
    for (let idx = 0; idx < walkable.length; idx++) if (walkable[idx]) this.walkableCells.push(idx);
  }

  setPointsOfInterest(points: [number, number][]): void {
    this.pointsOfInterest = points;
  }

  /** Sync with layout items, keeping the state of people that did not move in the editor. */
  sync(items: PersonItem[], previous: PersonState[]): void {
    const byId = new Map(previous.map((person) => [person.id, person]));
    this.people = items.map((item) => {
      const old = byId.get(item.id);
      const moved = !old || Math.abs(old.spawnX - item.x) > 1e-6 || Math.abs(old.spawnZ - item.z) > 1e-6;
      if (old && !moved && this.isWalkableWorld(old.x, old.z)) {
        old.item = item;
        if (item.behavior === 'stand') old.path = [];
        return old;
      }
      const [x, z] = this.nearestWalkable(item.x, item.z);
      return {
        id: item.id,
        item,
        x,
        z,
        yaw: item.yaw,
        vx: 0,
        vz: 0,
        walkPhase: this.random() * 10,
        path: [],
        pathIndex: 0,
        waitUntil: 2 + this.random() * 6,
        spawnX: item.x,
        spawnZ: item.z,
      };
    });
  }

  private cellCenter(cell: number): [number, number] {
    const k = Math.floor(cell / this.nx);
    const i = cell - k * this.nx;
    return [(i - 0.5) * this.h, (k - 0.5) * this.h];
  }

  private cellAt(x: number, z: number): number {
    const i = Math.min(this.nx - 2, Math.max(1, Math.floor(x / this.h + 1)));
    const k = Math.min(this.nz - 2, Math.max(1, Math.floor(z / this.h + 1)));
    return i + this.nx * k;
  }

  private isWalkableWorld(x: number, z: number): boolean {
    return this.walkable[this.cellAt(x, z)] === 1;
  }

  nearestWalkable(x: number, z: number): [number, number] {
    const start = this.cellAt(x, z);
    if (this.walkable[start]) return [x, z];
    let best = -1;
    let bestDist = Infinity;
    for (const cell of this.walkableCells) {
      const [cx, cz] = this.cellCenter(cell);
      const dist = (cx - x) ** 2 + (cz - z) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = cell;
      }
    }
    return best >= 0 ? this.cellCenter(best) : [x, z];
  }

  update(dt: number, time: number): void {
    for (const person of this.people) {
      if (person.item.behavior === 'stand') {
        person.vx *= 0.8;
        person.vz *= 0.8;
        continue;
      }
      if (person.pathIndex >= person.path.length) {
        person.vx = 0;
        person.vz = 0;
        if (time >= person.waitUntil) this.planNewTrip(person, time);
        continue;
      }
      const [tx, tz] = this.cellCenter(person.path[person.pathIndex]);
      const dx = tx - person.x;
      const dz = tz - person.z;
      const dist = Math.hypot(dx, dz);
      const step = person.item.speed * dt;
      if (dist <= step) {
        person.x = tx;
        person.z = tz;
        person.pathIndex++;
        if (person.pathIndex >= person.path.length) person.waitUntil = time + 3 + this.random() * 10;
      } else {
        person.x += (dx / dist) * step;
        person.z += (dz / dist) * step;
      }
      person.vx = dist > 1e-6 ? (dx / dist) * person.item.speed : 0;
      person.vz = dist > 1e-6 ? (dz / dist) * person.item.speed : 0;
      const targetYaw = Math.atan2(dx, dz);
      let delta = targetYaw - person.yaw;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      person.yaw += delta * Math.min(1, dt * 6);
      person.walkPhase += step / 0.7;
    }
  }

  private planNewTrip(person: PersonState, time: number): void {
    let goalX: number;
    let goalZ: number;
    if (this.pointsOfInterest.length > 0 && this.random() < 0.5) {
      const [px, pz] = this.pointsOfInterest[Math.floor(this.random() * this.pointsOfInterest.length)];
      const angle = this.random() * Math.PI * 2;
      [goalX, goalZ] = this.nearestWalkable(px + Math.cos(angle) * 0.7, pz + Math.sin(angle) * 0.7);
    } else if (this.walkableCells.length > 0) {
      [goalX, goalZ] = this.cellCenter(this.walkableCells[Math.floor(this.random() * this.walkableCells.length)]);
    } else {
      return;
    }
    const path = this.findPath(this.cellAt(person.x, person.z), this.cellAt(goalX, goalZ));
    if (path.length > 1) {
      person.path = path;
      person.pathIndex = 1;
    } else {
      person.waitUntil = time + 2;
    }
  }

  /** A* on the 8-connected walkable grid without corner cutting. */
  private findPath(start: number, goal: number): number[] {
    const { nx, walkable } = this;
    if (!walkable[start] || !walkable[goal]) return [];
    const total = walkable.length;
    const gScore = new Float32Array(total).fill(Infinity);
    const cameFrom = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const heap = new MinHeap();
    const gi = goal % nx;
    const gk = Math.floor(goal / nx);
    const heuristic = (cell: number) => {
      const di = Math.abs((cell % nx) - gi);
      const dk = Math.abs(Math.floor(cell / nx) - gk);
      return Math.max(di, dk) + 0.414 * Math.min(di, dk);
    };
    gScore[start] = 0;
    heap.push(start, heuristic(start));
    const offsets = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ];
    while (heap.size > 0) {
      const current = heap.pop();
      if (current === goal) break;
      if (closed[current]) continue;
      closed[current] = 1;
      for (const [di, dk, cost] of offsets) {
        const next = current + di + dk * nx;
        if (next < 0 || next >= total || !walkable[next] || closed[next]) continue;
        if (di !== 0 && dk !== 0 && (!walkable[current + di] || !walkable[current + dk * nx])) continue;
        const tentative = gScore[current] + cost;
        if (tentative < gScore[next]) {
          gScore[next] = tentative;
          cameFrom[next] = current;
          heap.push(next, tentative + heuristic(next));
        }
      }
    }
    if (cameFrom[goal] < 0 && goal !== start) return [];
    const path = [goal];
    let node = goal;
    while (node !== start) {
      node = cameFrom[node];
      if (node < 0) return [];
      path.push(node);
    }
    return path.reverse();
  }
}

class MinHeap {
  private items: number[] = [];
  private priorities: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.priorities.push(priority);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[index]) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && this.priorities[left] < this.priorities[smallest]) smallest = left;
        if (right < this.items.length && this.priorities[right] < this.priorities[smallest]) smallest = right;
        if (smallest === index) break;
        this.swap(index, smallest);
        index = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]];
  }
}
