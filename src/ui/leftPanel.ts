// Left panel: room presets, item palette, selected-item properties, smell sources, settings.

import GUI from 'lil-gui';
import { SOURCE_TYPES, getSourceType, type SourceCategory } from '../chem/sourceTypes';
import { PRESETS } from '../room/presets';
import type { FrameStats, Item, Layout, SourceInfo } from '../types';
import type { App } from '../app';
import { PALETTE } from './editor';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

const DEG = 180 / Math.PI;

function degrees(target: { yaw: number }, key: 'yaw' | 'pitch' | 'oscAmplitude' = 'yaw'): { value: number } {
  const record = target as unknown as Record<string, number>;
  return {
    get value() {
      return Math.round(record[key] * DEG);
    },
    set value(v: number) {
      record[key] = v / DEG;
    },
  };
}

export function sourceTypeOptions(): Record<string, string> {
  const options: Record<string, string> = {};
  const categories: SourceCategory[] = ['Food & drink', 'Materials', 'Plants & earth', 'Household', 'People'];
  for (const category of categories) {
    for (const type of SOURCE_TYPES.filter((t) => t.category === category && t.id !== 'human')) options[`${type.name} (${category})`] = type.id;
  }
  return options;
}

export class LeftPanel {
  private app: App;
  private presetSelect: HTMLSelectElement;
  private description: HTMLElement;
  private selectionHost: HTMLElement;
  private selectionGui: GUI | null = null;
  private legend: HTMLElement;
  private legendRows = new Map<string, HTMLElement>();
  private roomGui: GUI;
  private paletteButtons: HTMLButtonElement[] = [];

  constructor(root: HTMLElement, app: App) {
    this.app = app;

    root.append(element('h2', '', 'Room'));
    const presetCard = element('div', 'card');
    this.presetSelect = element('select');
    this.presetSelect.style.width = '100%';
    for (const preset of PRESETS) this.presetSelect.append(new Option(preset.build().name, preset.id));
    this.presetSelect.onchange = () => app.loadPreset(this.presetSelect.value);
    this.description = element('div', 'description');
    const fileRow = element('div', 'row');
    const save = element('button', '', 'Save layout');
    save.onclick = () => app.saveLayout();
    const load = element('button', '', 'Load layout');
    const fileInput = element('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';
    fileInput.style.display = 'none';
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (file) app.loadLayout(JSON.parse(await file.text()) as Layout);
      fileInput.value = '';
    };
    load.onclick = () => fileInput.click();
    fileRow.append(save, load, fileInput);
    presetCard.append(this.presetSelect, this.description, fileRow);
    root.append(presetCard);

    root.append(element('h2', '', 'Add to room <span class="muted">shift = repeat</span>'));
    const paletteCard = element('div', 'card');
    const palette = element('div', 'palette');
    const wallButton = element('button', '', 'Draw wall');
    wallButton.onclick = () => this.startPlacing(wallButton, { type: 'wall-draw' });
    palette.append(wallButton);
    this.paletteButtons.push(wallButton);
    for (const entry of PALETTE) {
      const button = element('button', '', entry.label);
      button.onclick = () => this.startPlacing(button, { type: entry.type, variant: entry.variant });
      palette.append(button);
      this.paletteButtons.push(button);
    }
    const sourceRow = element('div', 'source-picker');
    const sourceSelect = element('select');
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const type of SOURCE_TYPES) {
      if (type.id === 'human') continue;
      let group = groups.get(type.category);
      if (!group) {
        group = element('optgroup');
        group.label = type.category;
        groups.set(type.category, group);
        sourceSelect.append(group);
      }
      group.append(new Option(type.name, type.id));
    }
    const addSource = element('button', 'primary', '+ Smell source');
    addSource.onclick = () => this.startPlacing(addSource, { type: 'source', variant: sourceSelect.value });
    this.paletteButtons.push(addSource);
    sourceRow.append(sourceSelect, addSource);
    paletteCard.append(palette, sourceRow);
    root.append(paletteCard);

    root.append(element('h2', '', 'Selected'));
    this.selectionHost = element('div');
    root.append(this.selectionHost);
    this.showSelection(null);

    root.append(element('h2', '', 'Smell sources <span class="muted">air budget</span>'));
    this.legend = element('div', 'legend-list card');
    root.append(this.legend);
    root.append(
      element(
        'div',
        'description',
        'Bar: <span style="color:#4cf2ff">airborne</span> / <span style="color:#ff9f6b">decayed (ozone + surfaces)</span> / <span style="color:#7dff9b">filtered</span> share of everything emitted. The room is sealed, so odor only leaves the air by chemistry, sorption or filters.',
      ),
    );

    root.append(element('h2', '', 'Settings'));
    this.roomGui = new GUI({ container: root, title: 'Room and air', autoPlace: false });
    this.buildRoomGui();
    const physics = new GUI({ container: root, title: 'Physics', autoPlace: false });
    physics.close();
    const settings = app.settings;
    physics.add(settings, 'turbulence', 0, 0.3, 0.01).name('background eddies (m/s)').onChange(() => app.pushSettings());
    physics.add(settings, 'vorticity', 0, 2, 0.05).name('vorticity confinement').onChange(() => app.pushSettings());
    physics.add(settings, 'eddyDiffusivity', 0, 0.02, 0.0005).name('eddy diffusivity (m2/s)').onChange(() => app.pushSettings());
    physics.add(settings, 'pressureIters', 5, 80, 1).name('pressure iterations').onChange(() => app.pushSettings());
    physics.add(settings, 'particleCount', 0, 40000, 1000).name('tracer particles').onFinishChange(() => app.pushSettings());
    const viz = new GUI({ container: root, title: 'Visualization', autoPlace: false });
    viz.close();
    const volume = app.renderer.volume;
    viz.add(volume, 'density', 1, 80, 1).name('volume density');
    viz.add(volume, 'threshold', 0, 0.8, 0.01).name('hide faint below');
    viz.add(volume, 'maxOpacity', 0.1, 1, 0.05).name('max fog opacity');
    viz.add(settings, 'subtractBackground').name('hide room background').onChange(() => app.pushSettings());
    viz.add(settings, 'plumeDecades', 1, 6, 0.25).name('plume range (decades)').onChange(() => app.pushSettings());
    viz.add(volume, 'brightness', 0.2, 4, 0.05).name('volume brightness');
    viz.add(volume, 'sliceY', 0.05, app.layout.room.height, 0.05).name('slice height (m)').onChange((value: number) => (app.flowArrows.height = value));
    viz.add(volume, 'sliceOpacity', 0.1, 1, 0.05).name('slice opacity');
    viz.add(settings, 'ppmLogMin', -7, 2, 0.5).name('ppm view: log10 min').onChange(() => app.pushSettings());
    viz.add(settings, 'ppmLogMax', -3, 5, 0.5).name('ppm view: log10 max').onChange(() => app.pushSettings());
    viz.add(app.particleStyle, 'size', 1, 20, 0.5).name('particle size').onChange(() => app.applyParticleStyle());
  }

  private startPlacing(button: HTMLButtonElement, placement: Parameters<App['editor']['startPlacing']>[0]): void {
    const already = button.classList.contains('active');
    this.paletteButtons.forEach((b) => b.classList.remove('active'));
    if (already) {
      this.app.editor.startPlacing(null);
      return;
    }
    button.classList.add('active');
    this.app.editor.startPlacing(placement);
  }

  clearPaletteSelection(): void {
    this.paletteButtons.forEach((b) => b.classList.remove('active'));
  }

  buildRoomGui(): void {
    const app = this.app;
    const gui = this.roomGui;
    gui.controllersRecursive().forEach((controller) => controller.destroy());
    const room = app.layout.room;
    gui.add(room, 'width', 3, 30, 0.5).name('width (m)').onFinishChange(() => app.commitLayout(true));
    gui.add(room, 'depth', 3, 30, 0.5).name('depth (m)').onFinishChange(() => app.commitLayout(true));
    gui.add(room, 'height', 2.2, 8, 0.1).name('height (m)').onFinishChange(() => app.commitLayout(true));
    gui.add(room, 'cellSize', { '0.10 m (slow)': 0.1, '0.15 m': 0.15, '0.20 m': 0.2, '0.25 m': 0.25, '0.30 m (fast)': 0.3 }).name('grid cell').onFinishChange(() => app.commitLayout(true));
    gui.add(room, 'ambientTempC', 10, 32, 0.5).name('ambient temp (C)').onFinishChange(() => app.commitLayout());
    gui.add(room, 'ambientRH', 10, 90, 1).name('initial RH (%)').onFinishChange(() => app.commitLayout());
    gui.add(room, 'ozonePpb', 0, 100, 1).name('indoor ozone (ppb)').onFinishChange(() => app.commitLayout());
    gui.add(room, 'surfaceUptake', 0, 10, 0.1).name('surface uptake x').onFinishChange(() => app.commitLayout());
  }

  setPresetInfo(layout: Layout, presetId: string | null): void {
    if (presetId) this.presetSelect.value = presetId;
    this.description.textContent = layout.description;
    this.buildRoomGui();
  }

  showSelection(item: Item | 'device' | null): void {
    this.selectionGui?.destroy();
    this.selectionGui = null;
    this.selectionHost.innerHTML = '';
    const app = this.app;
    if (!item) {
      this.selectionHost.append(element('div', 'description card', 'Click an object in the room to edit it, or click the e-nose to move it. <span class="kbd">R</span> toggles rotate, <span class="kbd">Del</span> deletes, <span class="kbd">Cmd/Ctrl+D</span> duplicates.'));
      return;
    }
    const gui = new GUI({ container: this.selectionHost, autoPlace: false, title: item === 'device' ? 'E-nose pose' : `${item.name}` });
    this.selectionGui = gui;
    const commit = () => app.commitLayoutSoon();
    if (item === 'device') {
      const pose = app.devicePose;
      gui.add(pose.position, 'y', 0.05, app.layout.room.height - 0.1, 0.01).name('height (m)').onChange(() => app.applyDevicePose());
      gui.add(degrees(pose), 'value', -180, 180, 1).name('yaw (deg)').onChange(() => app.applyDevicePose());
      gui.add(degrees(pose as unknown as { yaw: number }, 'pitch'), 'value', -89, 60, 1).name('pitch (deg)').onChange(() => app.applyDevicePose());
      return;
    }
    gui.add(item, 'name').onFinishChange(commit);
    switch (item.type) {
      case 'block':
        gui.add(item, 'kind', ['wall', 'partition', 'shelf', 'counter', 'sofa', 'cabinet', 'bed', 'box']).onChange(commit);
        gui.add(item, 'w', 0.05, 20, 0.05).name('length / width (m)').onChange(commit);
        gui.add(item, 'd', 0.05, 20, 0.05).name('depth (m)').onChange(commit);
        gui.add(item, 'h', 0.05, app.layout.room.height, 0.05).name('height (m)').onChange(commit);
        gui.add(item, 'y', 0, app.layout.room.height, 0.05).name('base elevation (m)').onChange(commit);
        gui.add(degrees(item), 'value', -180, 180, 1).name('rotation (deg)').onChange(commit);
        gui.addColor(item, 'color').onChange(commit);
        break;
      case 'table':
        gui.add(item, 'w', 0.3, 6, 0.05).name('width (m)').onChange(commit);
        gui.add(item, 'd', 0.3, 6, 0.05).name('depth (m)').onChange(commit);
        gui.add(item, 'h', 0.3, 1.3, 0.01).name('top height (m)').onChange(commit);
        gui.add(degrees(item), 'value', -180, 180, 1).name('rotation (deg)').onChange(commit);
        gui.addColor(item, 'color').onChange(commit);
        break;
      case 'pillar':
        gui.add(item, 'radius', 0.08, 1.5, 0.01).name('radius (m)').onChange(commit);
        gui.add(item, 'h', 0.3, app.layout.room.height, 0.05).name('height (m)').onChange(commit);
        gui.addColor(item, 'color').onChange(commit);
        break;
      case 'fan':
        gui.add(item, 'on').onChange(commit);
        gui.add(item, 'speed', 0, 7, 0.1).name('air speed (m/s)').onChange(commit);
        gui.add(item, 'radius', 0.1, 0.6, 0.01).name('radius (m)').onChange(commit);
        gui.add(item, 'y', 0.2, app.layout.room.height - 0.2, 0.05).name('height (m)').onChange(commit);
        gui.add(degrees(item), 'value', -180, 180, 1).name('direction (deg)').onChange(commit);
        gui.add(degrees(item, 'pitch'), 'value', -60, 60, 1).name('tilt (deg)').onChange(commit);
        gui.add(item, 'oscillate').onChange(commit);
        gui.add(degrees(item, 'oscAmplitude'), 'value', 0, 90, 1).name('sweep (deg)').onChange(commit);
        gui.add(item, 'oscPeriod', 4, 60, 1).name('sweep period (s)').onChange(commit);
        break;
      case 'ceilingFan':
        gui.add(item, 'on').onChange(commit);
        gui.add(item, 'speed', 0, 4, 0.1).name('downdraft (m/s)').onChange(commit);
        gui.add(item, 'radius', 0.3, 2.5, 0.05).name('radius (m)').onChange(commit);
        gui.add(item, 'reverse').name('reverse (updraft)').onChange(commit);
        break;
      case 'heater':
        gui.add(item, 'on').onChange(commit);
        gui.add(item, 'power', 0, 3000, 50).name('power (W)').onChange(commit);
        gui.add(item, 'w', 0.2, 3, 0.05).name('width (m)').onChange(commit);
        gui.add(item, 'h', 0.2, 1.2, 0.05).name('height (m)').onChange(commit);
        gui.add(degrees(item), 'value', -180, 180, 1).name('rotation (deg)').onChange(commit);
        break;
      case 'hvac':
        gui.add(item, 'on').onChange(commit);
        gui.add(item, 'flow', 0, 0.5, 0.01).name('flow (m3/s)').onChange(commit);
        gui.add(item, 'supplyTempOffset', -10, 10, 0.5).name('supply temp offset (K)').onChange(commit);
        gui.add(item, 'filter', ['none', 'hepa', 'carbon']).onChange(commit);
        gui.add(item, 'returnHigh').name('return at ceiling').onChange(commit);
        gui.add(item, 'rx', 0, app.layout.room.width, 0.1).name('return x (m)').onChange(commit);
        gui.add(item, 'rz', 0, app.layout.room.depth, 0.1).name('return z (m)').onChange(commit);
        break;
      case 'purifier':
        gui.add(item, 'on').onChange(commit);
        gui.add(item, 'flow', 0, 0.2, 0.005).name('flow (m3/s)').onChange(commit);
        gui.add(item, 'filter', ['none', 'hepa', 'carbon']).onChange(commit);
        gui.add(degrees(item), 'value', -180, 180, 1).name('rotation (deg)').onChange(commit);
        break;
      case 'source': {
        const type = getSourceType(item.sourceType);
        gui.add(item, 'sourceType', sourceTypeOptions()).name('type').onChange((value: string) => {
          if (item.name === type.name) item.name = getSourceType(value).name;
          item.reservoirMinutes = getSourceType(value).reservoirMinutes;
          app.commitLayout();
          this.showSelection(item);
        });
        gui.add(item, 'emitting').onChange(commit);
        gui.add(item, 'strength', 0, 10, 0.1).name('strength x').onChange(commit);
        gui.add(item, 'pattern', ['steady', 'puffs']).onChange(commit);
        gui.add(item, 'puffPeriod', 3, 120, 1).name('puff period (s)').onChange(commit);
        gui.add(item, 'reservoirMinutes', 0, 240, 1).name('depletes in (min, 0 = never)').onChange(commit);
        gui.add(item, 'y', 0, app.layout.room.height, 0.01).name('elevation (m)').onChange(commit);
        gui.add({ refill: () => app.sim.refill(item.id) }, 'refill').name('refill / fresh sample');
        gui.add({ probe: () => app.probeSource(item.id) }, 'probe').name('move e-nose snout here');
        const info = element('div', 'description', `${type.description}<br><span class="muted">Material: ${type.material}. Headspace: ${Object.entries(type.headspace).map(([id, ppm]) => `${id.replace(/_/g, ' ')} ${ppm} ppm`).join(', ') || 'none'}${type.waterPpm ? `, water +${type.waterPpm} ppm` : ''}.</span>`);
        this.selectionHost.append(info);
        break;
      }
      case 'person':
        gui.add(item, 'behavior', ['wander', 'stand']).onChange(commit);
        gui.add(item, 'speed', 0.3, 2, 0.05).name('walk speed (m/s)').onChange(commit);
        gui.add(item, 'scent', { none: '', ...Object.fromEntries(SOURCE_TYPES.filter((t) => ['perfume', 'hand_sanitizer', 'mint_tea', 'garbage', 'fish', 'coffee', 'orange'].includes(t.id)).map((t) => [t.name, t.id])) }).name('carries scent').onChange(commit);
        gui.addColor(item, 'shirtColor').name('shirt').onChange(commit);
        break;
    }
    const actions = element('div', 'row');
    const remove = element('button', '', 'Delete');
    remove.onclick = () => app.editor.deleteSelected();
    const duplicate = element('button', '', 'Duplicate');
    duplicate.onclick = () => app.editor.duplicateSelected();
    actions.append(remove, duplicate);
    this.selectionHost.append(actions);
  }

  updateLegend(sources: SourceInfo[], stats: FrameStats | null, snoutPerSource: Float32Array | null): void {
    const app = this.app;
    const ids = new Set(sources.map((source) => source.id));
    for (const [id, row] of this.legendRows) {
      if (!ids.has(id)) {
        row.remove();
        this.legendRows.delete(id);
      }
    }
    sources.forEach((source, index) => {
      let row = this.legendRows.get(source.id);
      const item = app.layout.items.find((candidate) => candidate.id === source.id);
      if (!row) {
        row = element('div', 'legend-item');
        const [r, g, b] = source.color;
        row.innerHTML = `<span class="swatch" style="background:rgb(${r * 255},${g * 255},${b * 255})"></span><div><div class="name"></div><div class="meta"></div><div class="budget"><div class="a" style="background:#4cf2ff"></div><div class="d" style="background:#ff9f6b"></div><div class="f" style="background:#7dff9b"></div></div></div><div class="actions"></div>`;
        const actions = row.querySelector('.actions')!;
        if (item && item.type === 'source') {
          const toggle = element('button', '', item.emitting ? 'on' : 'off');
          toggle.title = 'Start / stop emitting (lid on, take it away)';
          toggle.onclick = (event) => {
            event.stopPropagation();
            item.emitting = !item.emitting;
            app.commitLayout();
          };
          const probe = element('button', '', 'probe');
          probe.title = 'Move the e-nose snout to this object';
          probe.onclick = (event) => {
            event.stopPropagation();
            app.probeSource(item.id);
          };
          actions.append(toggle, probe);
        }
        const solo = element('button', '', 'solo');
        solo.title = 'Show only this plume';
        solo.onclick = (event) => {
          event.stopPropagation();
          app.settings.vizSource = app.settings.vizSource === source.id ? '' : source.id;
          app.pushSettings();
        };
        actions.append(solo);
        row.onclick = () => {
          if (item) app.editor.select(item.id);
        };
        this.legend.append(row);
        this.legendRows.set(source.id, row);
      }
      row.classList.toggle('off', !!item && item.type === 'source' && !item.emitting);
      row.classList.toggle('selected', app.settings.vizSource === source.id);
      const toggle = row.querySelector('.actions button');
      if (toggle && item && item.type === 'source') toggle.textContent = item.emitting ? 'on' : 'off';
      (row.querySelector('.name') as HTMLElement).textContent = source.name;
      if (stats) {
        const statIndex = stats.sourceIds.indexOf(source.id);
        if (statIndex >= 0) {
          const emitted = stats.emitted[statIndex];
          const airborne = stats.airborne[statIndex];
          const decayed = stats.decayed[statIndex];
          const filtered = stats.filtered[statIndex];
          const total = Math.max(1e-12, airborne + decayed + filtered);
          (row.querySelector('.budget .a') as HTMLElement).style.width = `${(airborne / total) * 100}%`;
          (row.querySelector('.budget .d') as HTMLElement).style.width = `${(decayed / total) * 100}%`;
          (row.querySelector('.budget .f') as HTMLElement).style.width = `${(filtered / total) * 100}%`;
          const reservoir = stats.reservoir[statIndex];
          const atSnout = snoutPerSource ? snoutPerSource[index] : 0;
          const parts = [`${formatVolume(emitted)} emitted`, `${formatVolume(airborne)} in air`];
          if (item && item.type === 'source' && item.reservoirMinutes > 0) parts.push(`${Math.round(reservoir * 100)}% left`);
          if (atSnout > 1e-7) parts.push(`snout ${formatConcentration(atSnout)}`);
          (row.querySelector('.meta') as HTMLElement).textContent = parts.join(' | ');
        }
      }
    });
  }
}

function formatVolume(ml: number): string {
  if (ml >= 1) return `${ml.toFixed(1)} mL`;
  if (ml >= 1e-3) return `${(ml * 1000).toFixed(1)} uL`;
  return `${(ml * 1e6).toFixed(0)} nL`;
}

function formatConcentration(ppm: number): string {
  if (ppm >= 1) return `${ppm.toFixed(1)} ppm`;
  if (ppm >= 1e-3) return `${(ppm * 1000).toFixed(1)} ppb`;
  return `${(ppm * 1e6).toFixed(0)} ppt`;
}
