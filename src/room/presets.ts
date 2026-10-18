// Built-in rooms ("situations"). Every room is a closed system: no air enters or leaves.

import type { Layout, RoomSettings } from '../types';
import {
  createBlock,
  createCeilingFan,
  createFan,
  createHeater,
  createHvac,
  createPerson,
  createPillar,
  createPurifier,
  createSource,
  createTable,
} from './layoutUtils';
import { snapRoom, surfaceHeightAt } from './voxelize';

function room(width: number, depth: number, height: number, cellSize: number, extra: Partial<RoomSettings> = {}): RoomSettings {
  return { width, depth, height, cellSize, ambientTempC: 21, ambientRH: 40, ozonePpb: 15, surfaceUptake: 1, ...extra };
}

/** Rest sources on whatever is beneath them and snap the room to whole cells. */
function finalize(layout: Layout): Layout {
  snapRoom(layout);
  for (const item of layout.items) {
    if (item.type === 'source' && item.y === 0) item.y = surfaceHeightAt(layout, item.x, item.z, item.id);
  }
  return layout;
}

function studioApartment(): Layout {
  const H = 2.7;
  const wall = (x: number, z: number, w: number, d: number) => createBlock('wall', x, z, { w, d, h: H });
  const layout: Layout = {
    version: 1,
    name: 'Studio apartment',
    description:
      'Kitchen, living area, bedroom and bathroom with doorways. An oscillating fan stirs the living room while a radiator drives a warm plume.',
    room: room(10, 7, H, 0.2),
    items: [
      // bedroom (x 7..10, z 0..4) with doorway z 2.8..3.7
      wall(7, 1.4, 0.12, 2.8),
      wall(7, 3.85, 0.12, 0.3),
      wall(8.5, 4, 3, 0.12),
      // bathroom (x 0..2.5, z 0..2.5) with doorway x 1.6..2.5
      wall(2.5, 1.25, 0.12, 2.5),
      wall(0.8, 2.5, 1.6, 0.12),
      createBlock('counter', 4.5, 6.67, { name: 'Kitchen counter', w: 3.2 }),
      createBlock('sofa', 4.5, 2.9, { name: 'Sofa' }),
      createBlock('sofa', 6.5, 3.6, { name: 'Leather armchair', w: 0.9, d: 0.9, color: '#6b4430' }),
      createBlock('shelf', 0.22, 4.7, { name: 'Bookshelf', w: 0.4, d: 1.2 }),
      createBlock('bed', 8.6, 1.4, { name: 'Bed' }),
      createBlock('cabinet', 0.6, 0.3, { name: 'Bathroom cabinet', w: 0.8, d: 0.45, h: 0.85, color: '#e8eef2' }),
      createTable(4.5, 4.2, { name: 'Coffee table', w: 1.0, d: 0.6, h: 0.45 }),
      createSource('coffee', 3.6, 6.62),
      createSource('bread', 5.3, 6.62),
      createSource('garbage', 6.45, 6.7),
      createSource('roses', 4.5, 4.2),
      createSource('leather', 6.5, 3.6),
      createSource('old_books', 0.22, 4.7),
      createSource('polyester', 8.6, 1.0),
      createSource('hand_sanitizer', 0.6, 0.3),
      createSource('humidifier', 1.9, 0.5),
      createFan(2.9, 4.4, { yaw: Math.PI / 2, oscillate: true, speed: 2.5 }),
      createHeater(5, 0.12, { name: 'Radiator', power: 900 }),
      createPerson(5.5, 5.4, { name: 'Alex' }),
      createPerson(8.4, 3.0, { name: 'Sam', scent: 'perfume' }),
    ],
  };
  return finalize(layout);
}

function openOffice(): Layout {
  const H = 3;
  const items: Layout['items'] = [];
  for (const cx of [3.4, 7.6]) {
    for (const cz of [2.6, 6.4]) {
      items.push(createBlock('partition', cx, cz, { w: 3.0, h: 1.3, name: 'Desk partition' }));
      for (const dx of [-0.75, 0.75]) {
        for (const dz of [-0.48, 0.48]) items.push(createTable(cx + dx, cz + dz, { name: 'Desk', w: 1.4, d: 0.8, h: 0.74, color: '#cbb89d' }));
      }
    }
  }
  items.push(
    createPillar(5.5, 4.5, { radius: 0.3, h: H }),
    createPillar(10.5, 4.5, { radius: 0.3, h: H }),
    createBlock('wall', 12, 3, { w: 0.12, d: 6, h: H, name: 'Break room wall' }),
    createBlock('counter', 15.67, 3, { w: 0.65, d: 3.2, name: 'Break room counter' }),
    createTable(13.8, 3, { name: 'Break table', w: 1.2, d: 1.2 }),
    createBlock('shelf', 0.22, 5, { name: 'File shelf', w: 0.4, d: 1.6 }),
    createSource('coffee', 15.6, 2.2),
    createSource('popcorn', 15.6, 3.4),
    createSource('garbage', 15.7, 4.9),
    createSource('banana', 13.8, 3),
    createSource('cardboard', 1.0, 9.3),
    createSource('plastic', 2.2, 9.4),
    createSource('old_books', 0.22, 5),
    createSource('houseplant', 11.4, 9.4),
    createHvac(4.5, 4.5, { rx: 4.5, rz: 9.2, returnHigh: true, flow: 0.15, supplyTempOffset: -3, name: 'HVAC loop A' }),
    createHvac(9.5, 4.5, { rx: 9.5, rz: 0.8, returnHigh: true, flow: 0.15, supplyTempOffset: -3, name: 'HVAC loop B' }),
    createPerson(3.0, 4.5, { name: 'Priya' }),
    createPerson(8.0, 4.5, { name: 'Diego', scent: 'perfume' }),
    createPerson(13.5, 6.5, { name: 'Mei' }),
    createPerson(6.0, 8.6, { name: 'Jordan' }),
    createPerson(14.4, 1.4, { name: 'Ola', behavior: 'stand' }),
  );
  return finalize({
    version: 1,
    name: 'Open office',
    description:
      'Cubicle clusters, pillars and a break room. Two ceiling HVAC loops deliver cool air that sinks, then recirculate it through HEPA filters (which do not stop gases).',
    room: room(16, 10, H, 0.25),
    items,
  });
}

function materialsLab(): Layout {
  const benchMaterials = [
    ['pine_wood', 'old_books', 'cardboard', 'leather', 'plastic', 'rubber_mat'],
    ['polyester', 'brass', 'steel', 'glass_vase', 'brick', 'moss'],
  ];
  const items: Layout['items'] = [
    createTable(2.2, 3, { name: 'Bench A', w: 1.0, d: 4.6, h: 0.9, color: '#d7dde3' }),
    createTable(5.8, 3, { name: 'Bench B', w: 1.0, d: 4.6, h: 0.9, color: '#d7dde3' }),
    createPurifier(7.5, 0.5, { flow: 0.04 }),
    createPerson(4.0, 5.4, { name: 'Researcher', behavior: 'stand' }),
  ];
  benchMaterials.forEach((materials, benchIndex) => {
    materials.forEach((sourceType, index) => {
      items.push(createSource(sourceType, benchIndex === 0 ? 2.2 : 5.8, 1.15 + index * 0.74));
    });
  });
  return finalize({
    version: 1,
    name: 'Materials lab',
    description:
      'Twelve everyday materials on two benches in nearly still air. Probe each one with the e-nose: most materials are faint, so the snout has to almost touch them.',
    room: room(8, 6, 3, 0.2, { ozonePpb: 10 }),
    items,
  });
}

function kitchenDining(): Layout {
  const H = 2.8;
  return finalize({
    version: 1,
    name: 'Kitchen and dining',
    description:
      'Fish and cheese on the island, wine and a candle at dinner. A ceiling fan mixes the dining area; a recirculating HVAC loop with a carbon filter slowly scrubs the air.',
    room: room(12, 8, H, 0.2),
    items: [
      createBlock('counter', 3.5, 4, { name: 'Kitchen island', w: 2.4, d: 1.0 }),
      createBlock('counter', 3.5, 7.67, { name: 'Counter', w: 5 }),
      createTable(9, 4, { name: 'Dining table', w: 2.2, d: 1.0 }),
      createBlock('cabinet', 11.7, 7.5, { name: 'Sideboard', w: 0.5, d: 1.0, h: 0.9 }),
      createSource('fish', 3.0, 4.0),
      createSource('cheese', 4.2, 4.1),
      createSource('bread', 2.0, 7.62),
      createSource('coffee', 4.8, 7.62),
      createSource('garbage', 6.45, 7.65),
      createSource('red_wine', 8.4, 3.75),
      createSource('red_wine', 9.7, 4.25),
      createSource('candle', 9.05, 4.0),
      createSource('orange', 11.7, 7.5),
      createCeilingFan(9, 4, { radius: 0.65 }),
      createHeater(11.86, 2.0, { yaw: Math.PI / 2, power: 1000 }),
      createHvac(6, 1, { rx: 0.8, rz: 1.0, flow: 0.1, filter: 'carbon', name: 'HVAC (carbon filter)' }),
      createPerson(5.0, 2.2, { name: 'Chef' }),
      createPerson(9.0, 5.6, { name: 'Guest 1', behavior: 'stand' }),
      createPerson(10.2, 2.6, { name: 'Guest 2', scent: 'perfume' }),
    ],
  });
}

function galleryAtrium(): Layout {
  const H = 6;
  return finalize({
    version: 1,
    name: 'Gallery atrium',
    description:
      'A six-meter atrium with round columns and a mezzanine slab. Warm plumes from the heater and visitors rise and pool under the mezzanine; a large ceiling fan mixes the hall.',
    room: room(14, 12, H, 0.25, { ambientTempC: 19 }),
    items: [
      createBlock('box', 7, 10.25, { name: 'Mezzanine slab', w: 14, d: 3.5, y: 3.0, h: 0.25, color: '#cfc8bd' }),
      createPillar(3, 8.65, { h: 3.0, radius: 0.22 }),
      createPillar(7, 8.65, { h: 3.0, radius: 0.22 }),
      createPillar(11, 8.65, { h: 3.0, radius: 0.22 }),
      createPillar(4, 4, { radius: 0.45, h: H }),
      createPillar(10, 4, { radius: 0.45, h: H }),
      createBlock('box', 7, 4, { name: 'Plinth', w: 0.8, d: 0.8, h: 1.1, color: '#f2efe9' }),
      createBlock('box', 2, 2, { name: 'Plinth', w: 0.9, d: 0.9, h: 0.6, color: '#f2efe9' }),
      createBlock('box', 12, 2, { name: 'Plinth', w: 0.7, d: 0.7, h: 1.0, color: '#f2efe9' }),
      createBlock('counter', 12.2, 11.6, { name: 'Cafe counter', w: 3, d: 0.65 }),
      createTable(10.2, 9.8, { name: 'Cafe table', w: 0.8, d: 0.8 }),
      createSource('roses', 7, 4),
      createSource('grass', 2, 2),
      createSource('candle', 12, 2),
      createSource('coffee', 11.6, 11.55),
      createSource('bread', 12.8, 11.55),
      createSource('houseplant', 0.6, 7.6),
      createSource('houseplant', 13.4, 7.6),
      createSource('moss', 7, 7.2),
      createCeilingFan(7, 4, { radius: 1.4, speed: 1.2, name: 'HVLS fan' }),
      createHeater(1.2, 11.85, { power: 1500 }),
      createPerson(5, 6, { name: 'Visitor 1' }),
      createPerson(9, 6, { name: 'Visitor 2' }),
      createPerson(6, 2, { name: 'Visitor 3', scent: 'perfume' }),
      createPerson(11, 7, { name: 'Visitor 4' }),
      createPerson(3, 10, { name: 'Barista', behavior: 'stand' }),
    ],
  });
}

function testChamber(): Layout {
  return finalize({
    version: 1,
    name: 'Test chamber',
    description:
      'A small sealed chamber with one source. Watch pure dispersion, then switch on the fan or stop the source to see mixing and decay toward the well-mixed limit.',
    room: room(6, 4, 2.6, 0.15),
    items: [
      createTable(2.0, 2.0, { name: 'Sample table', w: 0.8, d: 0.8, h: 0.75 }),
      createSource('coffee', 2.0, 2.0),
      createFan(5.2, 2.0, { yaw: -Math.PI / 2, on: false, y: 0.9 }),
    ],
  });
}

export const PRESETS: { id: string; build: () => Layout }[] = [
  { id: 'studio', build: studioApartment },
  { id: 'lab', build: materialsLab },
  { id: 'kitchen', build: kitchenDining },
  { id: 'office', build: openOffice },
  { id: 'atrium', build: galleryAtrium },
  { id: 'chamber', build: testChamber },
];
