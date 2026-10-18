// Factories and helpers for layout items.

import { getSourceType } from '../chem/sourceTypes';
import type {
  BlockItem,
  BlockKind,
  CeilingFanItem,
  FanItem,
  HeaterItem,
  HvacItem,
  Item,
  ItemType,
  Layout,
  PersonItem,
  PillarItem,
  PurifierItem,
  SourceItem,
  TableItem,
} from '../types';

let idCounter = 0;

export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

const BLOCK_DEFAULTS: Record<BlockKind, { w: number; d: number; h: number; color: string; name: string }> = {
  wall: { w: 3, d: 0.12, h: 3, color: '#e9e4dc', name: 'Wall' },
  partition: { w: 1.6, d: 0.06, h: 1.5, color: '#7b8ea8', name: 'Partition' },
  shelf: { w: 1.2, d: 0.4, h: 1.9, color: '#8a6a4a', name: 'Bookshelf' },
  counter: { w: 2.0, d: 0.65, h: 0.92, color: '#d9d4cc', name: 'Counter' },
  sofa: { w: 2.0, d: 0.9, h: 0.8, color: '#5a6b8c', name: 'Sofa' },
  cabinet: { w: 0.8, d: 0.5, h: 1.1, color: '#b0a08a', name: 'Cabinet' },
  bed: { w: 1.6, d: 2.0, h: 0.55, color: '#c9d3e0', name: 'Bed' },
  box: { w: 0.8, d: 0.8, h: 0.8, color: '#a3a3a3', name: 'Box' },
};

export function createBlock(kind: BlockKind, x: number, z: number, overrides: Partial<BlockItem> = {}): BlockItem {
  const defaults = BLOCK_DEFAULTS[kind];
  return {
    id: newId(kind),
    type: 'block',
    kind,
    name: defaults.name,
    x,
    z,
    yaw: 0,
    y: 0,
    w: defaults.w,
    d: defaults.d,
    h: defaults.h,
    color: defaults.color,
    ...overrides,
  };
}

export function createTable(x: number, z: number, overrides: Partial<TableItem> = {}): TableItem {
  return { id: newId('table'), type: 'table', name: 'Table', x, z, yaw: 0, w: 1.4, d: 0.8, h: 0.75, color: '#a0774f', ...overrides };
}

export function createPillar(x: number, z: number, overrides: Partial<PillarItem> = {}): PillarItem {
  return { id: newId('pillar'), type: 'pillar', name: 'Pillar', x, z, yaw: 0, radius: 0.25, h: 3, color: '#d6d2ca', ...overrides };
}

export function createFan(x: number, z: number, overrides: Partial<FanItem> = {}): FanItem {
  return {
    id: newId('fan'),
    type: 'fan',
    name: 'Pedestal fan',
    x,
    z,
    yaw: 0,
    y: 1.1,
    pitch: 0,
    radius: 0.25,
    speed: 3,
    oscillate: false,
    oscAmplitude: Math.PI / 4,
    oscPeriod: 16,
    on: true,
    ...overrides,
  };
}

export function createCeilingFan(x: number, z: number, overrides: Partial<CeilingFanItem> = {}): CeilingFanItem {
  return { id: newId('cfan'), type: 'ceilingFan', name: 'Ceiling fan', x, z, yaw: 0, radius: 0.6, speed: 1.5, reverse: false, on: true, ...overrides };
}

export function createHeater(x: number, z: number, overrides: Partial<HeaterItem> = {}): HeaterItem {
  return { id: newId('heater'), type: 'heater', name: 'Radiator', x, z, yaw: 0, w: 0.9, d: 0.12, h: 0.55, power: 1200, on: true, ...overrides };
}

export function createHvac(x: number, z: number, overrides: Partial<HvacItem> = {}): HvacItem {
  return {
    id: newId('hvac'),
    type: 'hvac',
    name: 'HVAC loop',
    x,
    z,
    yaw: 0,
    rx: x + 3,
    rz: z,
    returnHigh: false,
    flow: 0.08,
    supplyTempOffset: 0,
    filter: 'hepa',
    on: true,
    ...overrides,
  };
}

export function createPurifier(x: number, z: number, overrides: Partial<PurifierItem> = {}): PurifierItem {
  return { id: newId('purifier'), type: 'purifier', name: 'Air purifier', x, z, yaw: 0, flow: 0.06, filter: 'carbon', on: true, ...overrides };
}

export function createSource(sourceType: string, x: number, z: number, overrides: Partial<SourceItem> = {}): SourceItem {
  const definition = getSourceType(sourceType);
  return {
    id: newId('src'),
    type: 'source',
    name: definition.name,
    sourceType,
    x,
    z,
    yaw: 0,
    y: 0,
    strength: 1,
    emitting: true,
    reservoirMinutes: definition.reservoirMinutes,
    pattern: 'steady',
    puffPeriod: 30,
    ...overrides,
  };
}

const SHIRT_COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#264653', '#8ab17d', '#b5838d', '#6d597a', '#457b9d'];

export function createPerson(x: number, z: number, overrides: Partial<PersonItem> = {}): PersonItem {
  return {
    id: newId('person'),
    type: 'person',
    name: 'Person',
    x,
    z,
    yaw: 0,
    speed: 1.1,
    behavior: 'wander',
    scent: '',
    shirtColor: SHIRT_COLORS[Math.floor(Math.random() * SHIRT_COLORS.length)],
    ...overrides,
  };
}

export function createItem(type: ItemType, x: number, z: number, variant?: string): Item {
  switch (type) {
    case 'block':
      return createBlock((variant as BlockKind) ?? 'box', x, z);
    case 'table':
      return createTable(x, z);
    case 'pillar':
      return createPillar(x, z);
    case 'fan':
      return createFan(x, z);
    case 'ceilingFan':
      return createCeilingFan(x, z);
    case 'heater':
      return createHeater(x, z);
    case 'hvac':
      return createHvac(x, z);
    case 'purifier':
      return createPurifier(x, z);
    case 'source':
      return createSource(variant ?? 'coffee', x, z);
    case 'person':
      return createPerson(x, z);
  }
}

export function cloneLayout(layout: Layout): Layout {
  return JSON.parse(JSON.stringify(layout)) as Layout;
}

/** Items that rest on whatever surface is beneath them. */
export function restsOnSurface(item: Item): boolean {
  return item.type === 'source';
}
