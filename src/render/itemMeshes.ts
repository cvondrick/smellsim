// Procedural meshes for room items and smell-source objects.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { getSourceType, type SourceType } from '../chem/sourceTypes';
import { PURIFIER_SIZE, TABLE_THICKNESS } from '../room/voxelize';
import type { BlockItem, CeilingFanItem, FanItem, HeaterItem, HvacItem, Item, PillarItem, PurifierItem, SourceItem, TableItem } from '../types';

export interface ItemView {
  object: THREE.Object3D;
  update?: (realTime: number, simTime: number, dt: number) => void;
}

const materialCache = new Map<string, THREE.MeshStandardMaterial>();

export function material(color: string, roughness = 0.75, metalness = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}|${JSON.stringify(extra)}`;
  let cached = materialCache.get(key);
  if (!cached) {
    cached = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
    materialCache.set(key, cached);
  }
  return cached;
}

function mesh(geometry: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const result = new THREE.Mesh(geometry, mat);
  result.position.set(x, y, z);
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
}

function hashString(text: string): () => number {
  let state = 0;
  for (let i = 0; i < text.length; i++) state = (Math.imul(state, 31) + text.charCodeAt(i)) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shade(color: string, factor: number): string {
  const c = new THREE.Color(color);
  c.multiplyScalar(factor);
  return `#${c.getHexString()}`;
}

// ---------------------------------------------------------------------------- blocks

function buildBlock(item: BlockItem): THREE.Group {
  const group = new THREE.Group();
  const { w, d, h, y, color } = item;
  const random = hashString(item.id);
  switch (item.kind) {
    case 'wall':
      group.add(box(w, h, d, material(color, 0.92), 0, y + h / 2, 0));
      break;
    case 'partition':
      group.add(box(w, h - 0.04, d, material(color, 0.95), 0, y + (h - 0.04) / 2, 0));
      group.add(box(w + 0.02, 0.04, d + 0.02, material('#9aa3ad', 0.4, 0.6), 0, y + h - 0.02, 0));
      break;
    case 'shelf': {
      const wood = material(color, 0.7);
      const shelves = 5;
      group.add(box(w, h, 0.02, wood, 0, y + h / 2, -d / 2 + 0.01));
      group.add(box(0.03, h, d, wood, -w / 2 + 0.015, y + h / 2, 0));
      group.add(box(0.03, h, d, wood, w / 2 - 0.015, y + h / 2, 0));
      for (let s = 0; s <= shelves; s++) {
        const sy = y + 0.02 + (s * (h - 0.04)) / shelves;
        group.add(box(w, 0.025, d, wood, 0, sy, 0));
        if (s === shelves) continue;
        let x = -w / 2 + 0.05;
        while (x < w / 2 - 0.08) {
          const bookW = 0.025 + random() * 0.04;
          const bookH = ((h - 0.04) / shelves) * (0.55 + random() * 0.35);
          const hue = random();
          const bookColor = `#${new THREE.Color().setHSL(hue, 0.35 + random() * 0.3, 0.3 + random() * 0.3).getHexString()}`;
          group.add(box(bookW, bookH, d * 0.75, material(bookColor, 0.8), x + bookW / 2, sy + 0.012 + bookH / 2, 0.02));
          x += bookW + 0.004;
        }
      }
      break;
    }
    case 'counter':
      group.add(box(w, h - 0.04, d - 0.04, material(shade(color, 0.85), 0.8), 0, y + (h - 0.04) / 2, 0.02));
      group.add(box(w + 0.02, 0.04, d, material('#3b3f45', 0.35, 0.1), 0, y + h - 0.02, 0));
      break;
    case 'sofa': {
      const fabric = material(color, 0.95);
      const seatH = h * 0.5;
      group.add(box(w, seatH, d, fabric, 0, y + seatH / 2, 0));
      group.add(box(w, h - seatH, d * 0.25, fabric, 0, y + seatH + (h - seatH) / 2, -d / 2 + d * 0.125));
      group.add(box(0.15, h * 0.75, d, material(shade(color, 0.9), 0.95), -w / 2 + 0.075, y + h * 0.375, 0));
      group.add(box(0.15, h * 0.75, d, material(shade(color, 0.9), 0.95), w / 2 - 0.075, y + h * 0.375, 0));
      break;
    }
    case 'cabinet':
      group.add(box(w, h, d, material(color, 0.6), 0, y + h / 2, 0));
      group.add(box(w * 0.3, 0.02, 0.02, material('#c0c4c8', 0.3, 0.8), 0, y + h * 0.8, d / 2 + 0.01));
      break;
    case 'bed':
      group.add(box(w, h * 0.45, d, material('#6d5a48', 0.7), 0, y + h * 0.225, 0));
      group.add(box(w - 0.06, h * 0.55, d - 0.06, material(color, 0.95), 0, y + h * 0.45 + h * 0.275, 0));
      group.add(box(w * 0.7, 0.12, 0.35, material('#ffffff', 0.95), 0, y + h + 0.06, -d / 2 + 0.3));
      break;
    default: {
      // overhead slabs (mezzanines, shelves above head height) are see-through from above
      const overhead = y >= 2.0;
      const slab = box(w, h, d, overhead ? material(color, 0.8, 0, { transparent: true, opacity: 0.35, depthWrite: false }) : material(color, 0.8), 0, y + h / 2, 0);
      if (overhead) slab.castShadow = true;
      group.add(slab);
    }
  }
  return group;
}

function buildTable(item: TableItem): THREE.Group {
  const group = new THREE.Group();
  const wood = material(item.color, 0.6);
  group.add(box(item.w, TABLE_THICKNESS, item.d, wood, 0, item.h - TABLE_THICKNESS / 2, 0));
  const legH = item.h - TABLE_THICKNESS;
  const inset = 0.06;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(box(0.05, legH, 0.05, material(shade(item.color, 0.75), 0.6), sx * (item.w / 2 - inset), legH / 2, sz * (item.d / 2 - inset)));
    }
  }
  return group;
}

function buildPillar(item: PillarItem): THREE.Group {
  const group = new THREE.Group();
  group.add(mesh(new THREE.CylinderGeometry(item.radius, item.radius, item.h, 32), material(item.color, 0.85), 0, item.h / 2, 0));
  group.add(mesh(new THREE.CylinderGeometry(item.radius * 1.15, item.radius * 1.15, 0.08, 32), material(shade(item.color, 0.9), 0.85), 0, 0.04, 0));
  return group;
}

// ---------------------------------------------------------------------------- air movers

function buildFan(item: FanItem, fanDirection: (fan: FanItem, time: number) => [number, number, number]): ItemView {
  const group = new THREE.Group();
  const dark = material('#2b2f36', 0.5, 0.3);
  const metal = material('#c9ced6', 0.35, 0.8);
  group.add(mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.04, 32), dark, 0, 0.02, 0));
  group.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, item.y - 0.1, 12), metal, 0, (item.y - 0.1) / 2, 0));
  const head = new THREE.Group();
  head.position.y = item.y;
  group.add(head);
  const motor = mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.14, 24), dark, 0, 0, -0.08);
  motor.rotation.x = Math.PI / 2;
  head.add(motor);
  const cage = mesh(new THREE.TorusGeometry(item.radius, 0.006, 8, 48), metal, 0, 0, 0.02);
  head.add(cage);
  const rear = mesh(new THREE.TorusGeometry(item.radius * 0.9, 0.005, 8, 48), metal, 0, 0, -0.02);
  head.add(rear);
  for (let s = 0; s < 6; s++) {
    const spoke = box(0.004, item.radius * 2, 0.004, metal, 0, 0, 0.022);
    spoke.rotation.z = (s * Math.PI) / 6;
    head.add(spoke);
  }
  const blades = new THREE.Group();
  blades.position.z = 0.0;
  head.add(blades);
  const bladeMaterial = material('#7fb8e8', 0.4, 0, { transparent: true, opacity: 0.85 });
  for (let b = 0; b < 3; b++) {
    const blade = box(item.radius * 0.36, item.radius * 0.85, 0.01, bladeMaterial, 0, item.radius * 0.45, 0);
    const pivot = new THREE.Group();
    pivot.rotation.z = (b * 2 * Math.PI) / 3;
    blade.rotation.y = 0.35;
    pivot.add(blade);
    blades.add(pivot);
  }
  let spin = 0;
  return {
    object: group,
    update: (_real, simTime, dt) => {
      const dir = fanDirection(item, simTime);
      // head orientation relative to the item's own yaw
      const worldYaw = Math.atan2(dir[0], dir[2]);
      head.rotation.set(0, 0, 0);
      head.rotation.order = 'YXZ';
      head.rotation.y = worldYaw - item.yaw;
      head.rotation.x = -item.pitch;
      if (item.on) spin += dt * item.speed * 9;
      blades.rotation.z = spin;
    },
  };
}

function buildCeilingFan(item: CeilingFanItem, roomHeight: number): ItemView {
  const group = new THREE.Group();
  const y = roomHeight - 0.45;
  const dark = material('#3a3530', 0.5, 0.4);
  group.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.45, 8), material('#b8b2a8', 0.4, 0.7), 0, roomHeight - 0.225, 0));
  group.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.12, 24), dark, 0, y, 0));
  const blades = new THREE.Group();
  blades.position.y = y - 0.02;
  group.add(blades);
  const bladeMaterial = material('#8a6a4a', 0.6);
  for (let b = 0; b < 5; b++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = (b * 2 * Math.PI) / 5;
    const blade = box(item.radius * 0.85, 0.012, 0.13, bladeMaterial, item.radius * 0.55, 0, 0);
    blade.rotation.x = 0.18;
    pivot.add(blade);
    blades.add(pivot);
  }
  let spin = 0;
  return {
    object: group,
    update: (_real, _sim, dt) => {
      if (item.on) spin += dt * item.speed * 3 * (item.reverse ? -1 : 1);
      blades.rotation.y = spin;
    },
  };
}

function buildHeater(item: HeaterItem): ItemView {
  const group = new THREE.Group();
  const fins = Math.max(4, Math.round(item.w / 0.06));
  const finMaterial = material('#e9ecef', 0.45, 0.3, { emissive: new THREE.Color('#ff5a1f'), emissiveIntensity: item.on ? 0.25 : 0 });
  for (let f = 0; f < fins; f++) {
    const x = -item.w / 2 + (f + 0.5) * (item.w / fins);
    group.add(box(item.w / fins - 0.012, item.h, item.d, finMaterial, x, 0.1 + item.h / 2, 0));
  }
  for (const sx of [-1, 1]) group.add(box(0.03, 0.1, item.d, material('#9aa0a6', 0.5, 0.6), sx * (item.w / 2 - 0.05), 0.05, 0));
  return { object: group };
}

function buildHvac(item: HvacItem, roomHeight: number): ItemView {
  const group = new THREE.Group();
  const supplyColor = item.supplyTempOffset < 0 ? '#5ec8ff' : item.supplyTempOffset > 0 ? '#ff9a5e' : '#9fe6c8';
  const panel = (x: number, z: number, y: number, color: string, size: number) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.add(box(size, 0.02, size, material('#e8eaed', 0.6, 0.2), 0, 0, 0));
    for (let r = 1; r <= 3; r++) {
      const s = (size * r) / 4;
      const ring = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(s, 0.022, s)),
        new THREE.LineBasicMaterial({ color }),
      );
      g.add(ring);
    }
    return g;
  };
  // children are relative to the supply diffuser at (x, z); the group moves both ends together
  const rx = item.rx - item.x;
  const rz = item.rz - item.z;
  group.add(panel(0, 0, roomHeight - 0.02, item.on ? supplyColor : '#888888', 0.6));
  const returnY = item.returnHigh ? roomHeight - 0.02 : 0.02;
  group.add(panel(rx, rz, returnY, item.on ? '#c7c7c7' : '#666666', 0.55));
  const ductY = roomHeight - 0.01;
  const ductPoints = [new THREE.Vector3(0, ductY, 0), new THREE.Vector3(rx, ductY, rz)];
  if (!item.returnHigh) ductPoints.push(new THREE.Vector3(rx, 0.03, rz));
  const duct = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(ductPoints),
    new THREE.LineDashedMaterial({ color: '#7fd1ff', dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.6 }),
  );
  duct.computeLineDistances();
  group.add(duct);
  return { object: group };
}

function buildPurifier(item: PurifierItem): ItemView {
  const group = new THREE.Group();
  const [w, h, d] = PURIFIER_SIZE;
  group.add(mesh(new RoundedBoxGeometry(w, h, d, 4, 0.05), material('#f1f3f5', 0.5), 0, h / 2, 0));
  group.add(mesh(new THREE.CylinderGeometry(w * 0.38, w * 0.38, 0.012, 32), material('#3c4048', 0.6), 0, h + 0.002, 0));
  group.add(box(w * 0.75, h * 0.45, 0.01, material('#c9cdd2', 0.8), 0, h * 0.3, d / 2 + 0.002));
  const led = mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: item.on ? (item.filter === 'carbon' ? '#3cff9a' : '#59b7ff') : '#444' }), 0, h * 0.8, d / 2 + 0.01);
  group.add(led);
  return { object: group };
}

// ---------------------------------------------------------------------------- smell sources

function lathe(points: [number, number][], segments = 32): THREE.LatheGeometry {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

export function buildSourceMesh(type: SourceType, seed = 'x'): THREE.Group {
  const group = new THREE.Group();
  const [w, h, d] = type.size;
  const accent = type.color;
  const random = hashString(seed + type.id);
  switch (type.shape) {
    case 'mug': {
      const r = w / 2;
      group.add(mesh(lathe([[0, 0], [r * 0.9, 0], [r, 0.01], [r, h], [r * 0.9, h], [r * 0.9, 0.012]]), material('#f4f1ea', 0.35)));
      const liquid = mesh(new THREE.CircleGeometry(r * 0.9, 24), material(type.id === 'coffee' ? '#3b2314' : '#a7c46a', 0.2));
      liquid.rotation.x = -Math.PI / 2;
      liquid.position.y = h * 0.85;
      group.add(liquid);
      const handle = mesh(new THREE.TorusGeometry(h * 0.28, 0.008, 8, 16, Math.PI), material('#f4f1ea', 0.35), r, h * 0.5, 0);
      handle.rotation.z = -Math.PI / 2;
      group.add(handle);
      break;
    }
    case 'glass': {
      const r = w / 2;
      const glass = material('#dfefff', 0.05, 0, { transparent: true, opacity: 0.35 });
      group.add(mesh(lathe([[r * 0.8, 0], [r * 0.8, 0.005], [0.006, 0.01], [0.005, h * 0.45], [r * 0.6, h * 0.55], [r, h * 0.8], [r * 0.85, h]]), glass));
      group.add(mesh(lathe([[0.0, h * 0.5], [r * 0.6, h * 0.56], [r * 0.85, h * 0.68], [0, h * 0.68]]), material(accent, 0.2)));
      break;
    }
    case 'bottle': {
      const r = w / 2;
      group.add(mesh(new THREE.CylinderGeometry(r, r, h * 0.7, 24), material(accent, 0.25, 0, { transparent: true, opacity: 0.85 }), 0, h * 0.35, 0));
      group.add(mesh(new THREE.CylinderGeometry(r * 0.35, r, h * 0.12, 24), material(accent, 0.25), 0, h * 0.76, 0));
      group.add(mesh(new THREE.CylinderGeometry(r * 0.4, r * 0.4, h * 0.14, 16), material('#f5f5f5', 0.4), 0, h * 0.89, 0));
      break;
    }
    case 'bowl': {
      const bowl = mesh(new THREE.SphereGeometry(w / 2, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), material('#e2dccf', 0.4));
      bowl.rotation.x = Math.PI;
      bowl.position.y = h;
      bowl.scale.y = (h / (w / 2)) * 1.0;
      group.add(bowl);
      for (let k = 0; k < 18; k++) {
        const angle = random() * Math.PI * 2;
        const radius = random() * w * 0.35;
        group.add(mesh(new THREE.IcosahedronGeometry(0.018 + random() * 0.01, 0), material(accent, 0.9), Math.cos(angle) * radius, h * 0.9 + random() * 0.03, Math.sin(angle) * radius));
      }
      break;
    }
    case 'plate': {
      group.add(mesh(new THREE.CylinderGeometry(w * 0.55, w * 0.5, 0.015, 32), material('#f2f2f2', 0.3), 0, 0.0075, 0));
      const fish = mesh(new THREE.SphereGeometry(0.5, 24, 12), material(accent, 0.4, 0.1), 0, 0.03, 0);
      fish.scale.set(w * 0.8, 0.035, d * 0.35);
      group.add(fish);
      break;
    }
    case 'vase': {
      const glass = type.id === 'glass_vase';
      const vaseMat = glass ? material('#cfe9ff', 0.05, 0, { transparent: true, opacity: 0.4 }) : material('#7e8fa8', 0.3);
      const vh = glass ? h : h * 0.45;
      const r = w * (glass ? 0.45 : 0.3);
      group.add(mesh(lathe([[0, 0], [r * 0.8, 0], [r, vh * 0.3], [r * 0.6, vh * 0.8], [r * 0.7, vh], [r * 0.6, vh]]), vaseMat));
      if (!glass) {
        for (let k = 0; k < 9; k++) {
          const angle = random() * Math.PI * 2;
          const lean = random() * 0.35;
          const stemH = h * (0.45 + random() * 0.4);
          const sx = Math.cos(angle) * Math.sin(lean) * stemH;
          const sz = Math.sin(angle) * Math.sin(lean) * stemH;
          const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, vh * 0.8, 0), new THREE.Vector3(sx, vh * 0.8 + stemH * Math.cos(lean), sz)]), new THREE.LineBasicMaterial({ color: '#3d7a3a' }));
          group.add(stem);
          group.add(mesh(new THREE.IcosahedronGeometry(0.03, 1), material(accent, 0.6), sx, vh * 0.8 + stemH * Math.cos(lean), sz));
        }
      }
      break;
    }
    case 'bin': {
      group.add(mesh(new THREE.CylinderGeometry(w / 2, w * 0.42, h * 0.95, 24), material('#55606b', 0.5, 0.2), 0, h * 0.475, 0));
      group.add(mesh(new THREE.CylinderGeometry(w / 2 + 0.01, w / 2 + 0.01, h * 0.05, 24), material('#3d454e', 0.5, 0.2), 0, h * 0.975, 0));
      break;
    }
    case 'candle': {
      group.add(mesh(new THREE.CylinderGeometry(w / 2, w / 2, h * 0.75, 24), material('#fff2dc', 0.6), 0, h * 0.375, 0));
      group.add(mesh(new THREE.CylinderGeometry(w / 2 + 0.006, w / 2 + 0.006, h * 0.5, 24), material('#c9b79c', 0.3, 0, { transparent: true, opacity: 0.5 }), 0, h * 0.25, 0));
      const flame = mesh(new THREE.ConeGeometry(0.008, 0.035, 12), new THREE.MeshBasicMaterial({ color: '#ffcf6a' }), 0, h * 0.75 + 0.02, 0);
      flame.castShadow = false;
      group.add(flame);
      break;
    }
    case 'books': {
      let y = 0;
      for (let k = 0; k < 4; k++) {
        const bh = 0.035 + random() * 0.02;
        const book = box(w * (0.8 + random() * 0.2), bh, d * (0.8 + random() * 0.2), material(`#${new THREE.Color().setHSL(random(), 0.35, 0.35).getHexString()}`, 0.85), 0, y + bh / 2, 0);
        book.rotation.y = (random() - 0.5) * 0.3;
        group.add(book);
        y += bh;
      }
      break;
    }
    case 'plank':
      group.add(box(w, h, d, material(accent, 0.7), 0, h / 2, 0));
      break;
    case 'plant': {
      group.add(mesh(new THREE.CylinderGeometry(w * 0.3, w * 0.24, h * 0.3, 20), material('#b5653d', 0.7), 0, h * 0.15, 0));
      for (let k = 0; k < 14; k++) {
        const angle = random() * Math.PI * 2;
        const radius = random() * w * 0.4;
        const leaf = mesh(new THREE.IcosahedronGeometry(w * (0.12 + random() * 0.08), 0), material(shade(accent, 0.7 + random() * 0.5), 0.8), Math.cos(angle) * radius, h * (0.35 + random() * 0.6), Math.sin(angle) * radius);
        leaf.scale.y = 0.5;
        group.add(leaf);
      }
      break;
    }
    case 'loaf': {
      const loaf = mesh(new THREE.SphereGeometry(0.5, 24, 16), material(accent, 0.85), 0, h / 2, 0);
      loaf.scale.set(w, h, d);
      group.add(loaf);
      break;
    }
    case 'box': {
      group.add(box(w, h, d, material(accent, 0.9), 0, h / 2, 0));
      group.add(box(w + 0.002, 0.004, 0.05, material('#d9c9a3', 0.5), 0, h, 0));
      break;
    }
    case 'cushion':
      group.add(mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(h / 2, 0.05)), material(accent, 0.9), 0, h / 2, 0));
      break;
    case 'container':
      group.add(mesh(new RoundedBoxGeometry(w, h, d, 3, 0.02), material(accent, 0.3, 0, { transparent: true, opacity: 0.8 }), 0, h / 2, 0));
      break;
    case 'slab':
      group.add(box(w, h, d, material(accent, 0.9), 0, h / 2, 0));
      break;
    case 'bucket': {
      group.add(mesh(new THREE.CylinderGeometry(w / 2, w * 0.4, h, 24, 1, true), material('#4b8fd6', 0.4), 0, h / 2, 0));
      const liquid = mesh(new THREE.CircleGeometry(w * 0.47, 24), material(accent, 0.15));
      liquid.rotation.x = -Math.PI / 2;
      liquid.position.y = h * 0.8;
      group.add(liquid);
      const handle = mesh(new THREE.TorusGeometry(w / 2, 0.005, 6, 24, Math.PI), material('#c0c0c0', 0.3, 0.8), 0, h, 0);
      group.add(handle);
      break;
    }
    case 'can': {
      group.add(mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 32, 1, true), material('#b9bec4', 0.3, 0.9), 0, h / 2, 0));
      const paint = mesh(new THREE.CircleGeometry(w / 2, 32), material(accent, 0.2));
      paint.rotation.x = -Math.PI / 2;
      paint.position.y = h * 0.95;
      group.add(paint);
      break;
    }
    case 'fruit': {
      if (type.id === 'banana') {
        for (let k = 0; k < 4; k++) {
          const banana = mesh(new THREE.TorusGeometry(w * 0.45, 0.018, 8, 16, Math.PI * 0.7), material(accent, 0.6), 0, 0.02 + k * 0.012, (k - 1.5) * 0.03);
          banana.rotation.x = -Math.PI / 2;
          banana.rotation.z = Math.PI * 0.15 + k * 0.05;
          group.add(banana);
        }
      } else {
        group.add(mesh(new THREE.SphereGeometry(w / 2, 24, 16), material(accent, 0.7), 0, w / 2, 0));
        for (let k = 0; k < 3; k++) {
          const peel = mesh(new THREE.SphereGeometry(w * 0.3, 12, 8, 0, Math.PI), material(shade(accent, 0.9), 0.8), (random() - 0.5) * w * 2, 0.012, (random() - 0.5) * w * 2);
          peel.scale.y = 0.25;
          group.add(peel);
        }
      }
      break;
    }
    case 'tray': {
      group.add(box(w, h * 0.4, d, material('#5b4636', 0.8), 0, h * 0.2, 0));
      const blades = type.id === 'grass';
      for (let k = 0; k < (blades ? 60 : 30); k++) {
        const x = (random() - 0.5) * w * 0.9;
        const z = (random() - 0.5) * d * 0.9;
        if (blades) {
          const blade = mesh(new THREE.ConeGeometry(0.006, 0.06 + random() * 0.04, 4), material(shade(accent, 0.7 + random() * 0.5), 0.8), x, h * 0.4 + 0.04, z);
          blade.rotation.z = (random() - 0.5) * 0.4;
          group.add(blade);
        } else {
          const tuft = mesh(new THREE.IcosahedronGeometry(0.025 + random() * 0.02, 0), material(shade(accent, 0.7 + random() * 0.5), 0.95), x, h * 0.45, z);
          tuft.scale.y = 0.5;
          group.add(tuft);
        }
      }
      break;
    }
    case 'rail': {
      const metal = material(accent, 0.3, 0.9);
      const bar = mesh(new THREE.CylinderGeometry(0.02, 0.02, w, 16), metal, 0, h / 2 + 0.25, 0);
      bar.rotation.z = Math.PI / 2;
      group.add(bar);
      for (const sx of [-1, 1]) group.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.25, 12), metal, (sx * w) / 2.4, 0.125, 0));
      break;
    }
    case 'knob': {
      const brass = material(accent, 0.25, 0.95);
      group.add(box(0.03, 0.12, 0.012, brass, 0, 0.06, 0));
      const lever = mesh(new THREE.CylinderGeometry(0.009, 0.009, w, 12), brass, w / 2 - 0.01, 0.07, 0.02);
      lever.rotation.z = Math.PI / 2;
      group.add(lever);
      break;
    }
  }
  return group;
}

function buildSource(item: SourceItem): ItemView {
  const type = getSourceType(item.sourceType);
  const group = new THREE.Group();
  const object = buildSourceMesh(type, item.id);
  object.position.y = item.y;
  group.add(object);
  // ground ring in the source color (visualization layer)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(type.size[0], type.size[2]) * 0.6 + 0.02, Math.max(type.size[0], type.size[2]) * 0.6 + 0.04, 40),
    new THREE.MeshBasicMaterial({ color: type.color, transparent: true, opacity: item.emitting ? 0.9 : 0.25, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = item.y + 0.003;
  ring.layers.set(1);
  group.add(ring);
  return { object: group };
}

// ---------------------------------------------------------------------------- dispatch

export function buildItemView(item: Item, roomHeight: number, fanDirection: (fan: FanItem, time: number) => [number, number, number]): ItemView | null {
  let view: ItemView | null = null;
  switch (item.type) {
    case 'block':
      view = { object: buildBlock(item) };
      break;
    case 'table':
      view = { object: buildTable(item) };
      break;
    case 'pillar':
      view = { object: buildPillar(item) };
      break;
    case 'fan':
      view = buildFan(item, fanDirection);
      break;
    case 'ceilingFan':
      view = buildCeilingFan(item, roomHeight);
      break;
    case 'heater':
      view = buildHeater(item);
      break;
    case 'hvac':
      view = buildHvac(item, roomHeight);
      break;
    case 'purifier':
      view = buildPurifier(item);
      break;
    case 'source':
      view = buildSource(item);
      break;
    case 'person':
      return null; // people are animated by PeopleView
  }
  if (!view) return null;
  view.object.position.set(item.x, 0, item.z);
  view.object.rotation.y = item.type === 'hvac' ? 0 : item.yaw;
  view.object.traverse((child) => {
    child.userData.itemId = item.id;
  });
  return view;
}
