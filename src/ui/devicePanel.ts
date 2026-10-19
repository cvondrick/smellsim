// Right panel: the e-nose instrument, its raw signal, smellprint, PCA and a human-nose comparison.

import { COMPOUNDS } from '../chem/compounds';
import { intensityLabel } from '../chem/perception';
import { pca } from '../device/analysis';
import { METHODS, type Measurement } from '../device/cyranose';
import { DEFAULT_PROFILE, PROFILES, type ProfileId } from '../device/profiles';
import type { App } from '../app';
import type { Layout } from '../types';
import { drawHeatmap, drawScatter, drawSmellprint, drawTraces, PHASE_COLORS, type ChannelLabel } from './charts';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

function canvas(height: number): HTMLCanvasElement {
  const node = element('canvas', 'chart');
  node.style.height = `${height}px`;
  return node;
}

export function formatPpm(ppm: number): string {
  if (ppm >= 1000) return `${(ppm / 1000).toFixed(1)}k ppm`;
  if (ppm >= 1) return `${ppm.toFixed(ppm >= 100 ? 0 : 1)} ppm`;
  if (ppm >= 1e-3) return `${(ppm * 1000).toFixed(ppm >= 0.1 ? 0 : 1)} ppb`;
  if (ppm >= 1e-6) return `${(ppm * 1e6).toFixed(ppm * 1e6 >= 100 ? 0 : 1)} ppt`;
  return '< 1 ppt';
}

export interface SnoutReadout {
  nearestName: string;
  nearestColor: string;
  distance: number;
  rh: number;
  tempC: number;
  speed: number;
  pidPpb: number;
  compounds: { index: number; ppm: number }[];
  human: { name: string; color: string; intensity: number; adapted: number; descriptor: string }[];
}

export class DevicePanel {
  private app: App;
  private phasePill: HTMLElement;
  private progress: HTMLElement;
  private runButton: HTMLButtonElement;
  private liveButton: HTMLButtonElement;
  private readouts: HTMLElement;
  private compoundList: HTMLElement;
  private traces: HTMLCanvasElement;
  private heatmap: HTMLCanvasElement;
  private heatmapCaption: HTMLElement;
  private smellprint: HTMLCanvasElement;
  private smellprintCaption: HTMLElement;
  private scatter: HTMLCanvasElement;
  private captures: HTMLElement;
  private human: HTMLElement;
  private pip: HTMLCanvasElement;
  private probeSelect!: HTMLSelectElement;
  private profileNote!: HTMLElement;
  heatmapMode: 'relative' | 'raw' = 'relative';
  selectedMeasurement: number | null = null;
  private lastCaptureCount = -1;

  constructor(root: HTMLElement, app: App) {
    this.app = app;
    root.append(element('h2', '', 'Cyranose 320 <span class="muted">simulated e-nose</span>'));

    const control = element('div', 'card');
    const status = element('div', 'status-line');
    this.phasePill = element('span', 'phase-pill', 'Ready');
    status.append(this.phasePill, element('span', 'muted', '<span class="kbd">Space</span> run'));
    this.progress = element('div', 'progress', '<div></div>');
    const buttons = element('div', 'row');
    this.runButton = element('button', 'primary', 'Run measurement');
    this.runButton.onclick = () => app.runMeasurement();
    this.liveButton = element('button', '', 'Live sniff');
    this.liveButton.title = 'Continuously draw air through the snout';
    this.liveButton.onclick = () => app.toggleLive();
    const zero = element('button', '', 'Zero');
    zero.title = 'Reset the strip-chart reference to the current resistances';
    zero.onclick = () => app.device.zeroReference();
    buttons.append(this.runButton, this.liveButton, zero);
    const methodRow = element('div', 'row');
    const methodSelect = element('select');
    METHODS.forEach((method, index) => methodSelect.append(new Option(`${method.name} (${method.phases.reduce((s, p) => s + p.duration, 0)} s)`, String(index))));
    methodSelect.onchange = () => app.device.setMethod(METHODS[Number(methodSelect.value)]);
    const filterToggle = element('label', 'toggle', '<input type="checkbox"> carbon filter on side inlet');
    const filterInput = filterToggle.querySelector('input')!;
    filterInput.onchange = () => {
      for (const method of METHODS) method.intakeFilter = filterInput.checked;
    };
    methodRow.append(methodSelect, filterToggle);
    const profileRow = element('div', 'row');
    const profileSelect = element('select');
    profileSelect.style.flex = '1';
    profileSelect.title = 'Which channel physics the simulated e-nose uses';
    for (const id of Object.keys(PROFILES) as ProfileId[]) profileSelect.append(new Option(`Sensors: ${PROFILES[id]().name}`, id));
    profileSelect.value = DEFAULT_PROFILE;
    profileSelect.onchange = () => {
      app.device.setProfile(profileSelect.value as ProfileId);
      this.selectedMeasurement = null;
      this.profileNote.textContent = app.device.sensors.profile.description;
    };
    profileRow.append(profileSelect);
    this.profileNote = element('div', 'description', app.device.sensors.profile.description);
    const probeRow = element('div', 'row');
    const probeSelect = element('select');
    probeSelect.id = 'probe-select';
    probeSelect.style.flex = '1';
    probeSelect.onchange = () => {
      if (probeSelect.value) app.probeSource(probeSelect.value);
      probeSelect.value = '';
      probeSelect.blur();
    };
    this.probeSelect = probeSelect;
    const ambient = element('button', '', 'Room air');
    ambient.title = 'Move the device to the middle of the room, away from sources';
    ambient.onclick = () => app.moveDeviceToRoomCenter();
    probeRow.append(probeSelect, ambient);
    control.append(status, this.progress, buttons, methodRow, profileRow, this.profileNote, probeRow);
    root.append(control);

    root.append(element('h2', '', 'At the snout tip <span class="muted">ground truth</span>'));
    const truth = element('div', 'card');
    this.readouts = element('div', 'readouts');
    this.compoundList = element('div', 'compound-list');
    truth.append(this.readouts, this.compoundList);
    root.append(truth);

    root.append(element('h2', '', 'Live sensor traces'));
    this.traces = canvas(130);
    root.append(this.traces);

    const heatHeader = element('h2', '', 'Raw signal: 32 sensors x T');
    const heatToggle = element('div', 'segmented');
    (['relative', 'raw'] as const).forEach((mode) => {
      const button = element('button', mode === this.heatmapMode ? 'active' : '', mode === 'relative' ? 'dR/R0' : 'R');
      button.style.fontSize = '10px';
      button.style.padding = '1px 7px';
      button.onclick = () => {
        this.heatmapMode = mode;
        heatToggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        button.classList.add('active');
      };
      heatToggle.append(button);
    });
    heatHeader.append(heatToggle);
    root.append(heatHeader);
    this.heatmap = canvas(200);
    this.heatmapCaption = element('div', 'description');
    root.append(this.heatmap, this.heatmapCaption);

    root.append(element('h2', '', 'Smellprint <span class="muted">(Rmax - R0) / R0</span>'));
    this.smellprint = canvas(140);
    this.smellprintCaption = element('div', 'description');
    root.append(this.smellprint, this.smellprintCaption);

    root.append(element('h2', '', 'Smell space <span class="muted">PCA of captures</span>'));
    this.scatter = canvas(190);
    root.append(this.scatter);

    const captureHeader = element('h2', '', 'Captures');
    const captureButtons = element('div', 'row');
    const exportButton = element('button', '', 'Export JSON');
    exportButton.style.fontSize = '10px';
    exportButton.onclick = () => this.exportCaptures();
    const clearButton = element('button', '', 'Clear');
    clearButton.style.fontSize = '10px';
    clearButton.onclick = () => {
      app.device.measurements = [];
      this.selectedMeasurement = null;
    };
    captureButtons.append(exportButton, clearButton);
    captureHeader.append(captureButtons);
    root.append(captureHeader);
    this.captures = element('div', 'capture-list card');
    root.append(this.captures);

    root.append(element('h2', '', 'Human nose at the snout'));
    this.human = element('div', 'card bars');
    root.append(this.human);

    root.append(element('h2', '', 'Snout camera'));
    this.pip = element('canvas', 'pip');
    this.pip.width = 384;
    this.pip.height = 216;
    root.append(this.pip);
  }

  refreshProbeTargets(layout: Layout): void {
    this.probeSelect.innerHTML = '';
    this.probeSelect.append(new Option('Move snout to...', ''));
    for (const item of layout.items) if (item.type === 'source') this.probeSelect.append(new Option(item.name, item.id));
  }

  private measurementToShow(): Measurement | null {
    const measurements = this.app.device.measurements;
    if (this.selectedMeasurement !== null) {
      const found = measurements.find((m) => m.id === this.selectedMeasurement);
      if (found) return found;
    }
    return measurements[measurements.length - 1] ?? null;
  }

  update(readout: SnoutReadout | null): void {
    const device = this.app.device;
    const phase = device.currentPhase;
    const live = device.mode === 'live';
    this.phasePill.textContent = live ? 'Live sniff' : phase ? phase.label : 'Ready';
    this.phasePill.style.borderColor = live ? PHASE_COLORS.live : phase ? PHASE_COLORS[phase.kind] : '';
    const progress = device.mode === 'cycle' ? device.cycleElapsed / device.cycleDuration : 0;
    (this.progress.firstElementChild as HTMLElement).style.width = `${(progress * 100).toFixed(1)}%`;
    this.runButton.disabled = device.mode === 'cycle';
    this.runButton.textContent = device.mode === 'cycle' ? 'Measuring...' : 'Run measurement';
    this.liveButton.classList.toggle('active', live);
    this.liveButton.disabled = device.mode === 'cycle';

    if (readout) {
      this.readouts.innerHTML = [
        ['Nearest object', `<span style="color:${readout.nearestColor}">${readout.nearestName}</span>`],
        ['Distance to surface', readout.distance < 5 ? `${(readout.distance * 100).toFixed(1)} cm` : '-'],
        ['Rel. humidity', `${readout.rh.toFixed(1)} %`],
        ['Air temperature', `${readout.tempC.toFixed(1)} C`],
        ['Air speed', `${(readout.speed * 100).toFixed(0)} cm/s`],
        ['PID (total VOC)', `${readout.pidPpb.toFixed(readout.pidPpb >= 100 ? 0 : 1)} ppb`],
      ]
        .map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`)
        .join('');
      this.compoundList.innerHTML =
        readout.compounds.length > 0
          ? readout.compounds.map(({ index, ppm }) => `<b>${COMPOUNDS[index].name}</b> ${formatPpm(ppm)}`).join(' &middot; ')
          : 'Clean air: no odorants above 1 ppt.';
      this.human.innerHTML =
        readout.human.length > 0
          ? readout.human
              .map(
                (entry) => `<div class="bar-row"><span title="${entry.descriptor}">${entry.name}</span><div class="track"><div class="fill" style="width:${(entry.adapted / 5) * 100}%;background:${entry.color}"></div></div><span class="muted">${intensityLabel(entry.adapted)}</span></div>`,
              )
              .join('') +
            `<div class="description">Odor activity = concentration / human threshold. Bars include adaptation: a steady smell fades over minutes. Notes: ${readout.human
              .slice(0, 3)
              .map((entry) => entry.descriptor)
              .join(', ')}.</div>`
          : '<div class="description">Nothing above human odor thresholds here.</div>';
    }

    const channels: ChannelLabel[] = device.sensors.profile.channels.map((channel) => ({ label: channel.label, color: channel.color, active: channel.kind === 'active' }));
    drawTraces(this.traces, device.historyTimes, device.historyValues, device.historyPhases, channels);

    const measurement = this.measurementToShow();
    const running = device.mode === 'cycle';
    if (running) {
      const rows = device.currentRows();
      drawHeatmap(this.heatmap, { rows: rows.rows, phases: rows.phases, baselineMean: rows.baselineMean }, this.heatmapMode, channels);
      this.heatmapCaption.textContent = `Recording: ${rows.rows.length} timesteps at ${device.method.sampleRateHz} Hz (yellow = baseline via side inlet, cyan = sample via snout).`;
    } else if (measurement) {
      const rows = [...measurement.baseline, ...measurement.sample];
      const width = measurement.baseline[0]?.length ?? channels.length;
      const baselineMean = new Float64Array(width);
      for (const row of measurement.baseline) for (let i = 0; i < width; i++) baselineMean[i] += row[i] / measurement.baseline.length;
      drawHeatmap(this.heatmap, { rows, phases: measurement.phases, baselineMean }, this.heatmapMode, channels);
      this.heatmapCaption.textContent = `#${measurement.id} ${measurement.label}: ${measurement.baseline.length} baseline + ${measurement.sample.length} sample timesteps (${measurement.method}).`;
    } else {
      drawHeatmap(this.heatmap, { rows: [], phases: [], baselineMean: null }, this.heatmapMode, channels);
      this.heatmapCaption.textContent = 'Move the snout next to an object and press Run measurement.';
    }

    if (measurement) {
      drawSmellprint(this.smellprint, measurement.smellprint, channels);
      const match = measurement.match ? ` Most similar earlier capture: ${measurement.match.label} (cosine ${measurement.match.similarity.toFixed(2)}).` : '';
      const truth = measurement.truth;
      this.smellprintCaption.innerHTML = `<b style="color:${measurement.color}">${measurement.label}</b>, snout ${truth.distance < 5 ? (truth.distance * 100).toFixed(1) + ' cm' : 'far'} from surface, RH ${truth.rh.toFixed(0)}%.${match}`;
    } else {
      drawSmellprint(this.smellprint, null, channels);
      this.smellprintCaption.textContent = '';
    }

    const measurements = device.measurements;
    // PCA on active channels only: non-sensing positions carry readout noise and spikes
    const activeIndex = channels.flatMap((channel, i) => (channel.active ? [i] : []));
    const result = pca(measurements.map((m) => activeIndex.map((i) => m.smellprint[i])));
    if (result) {
      drawScatter(
        this.scatter,
        result.scores.map(([x, y], index) => ({
          x,
          y,
          color: measurements[index].color,
          label: measurements[index].label,
          highlight: measurement !== null && measurements[index].id === measurement.id,
        })),
        [`PC1 ${(result.explained[0] * 100).toFixed(0)}%`, `PC2 ${(result.explained[1] * 100).toFixed(0)}%`],
      );
    } else {
      drawScatter(this.scatter, [], ['PC1', 'PC2']);
    }

    if (measurements.length !== this.lastCaptureCount || this.captures.dataset.selected !== String(measurement?.id ?? '')) {
      this.lastCaptureCount = measurements.length;
      this.captures.dataset.selected = String(measurement?.id ?? '');
      this.captures.innerHTML = '';
      if (measurements.length === 0) this.captures.innerHTML = '<div class="description">No captures yet.</div>';
      for (const m of [...measurements].reverse()) {
        const row = element('div', 'capture' + (measurement && m.id === measurement.id ? ' selected' : ''));
        row.innerHTML = `<span class="swatch" style="background:${m.color}"></span><span>#${m.id} ${m.label}</span><span class="muted">${Math.floor(m.simTime / 60)}:${String(Math.floor(m.simTime % 60)).padStart(2, '0')}</span>`;
        row.onclick = () => {
          this.selectedMeasurement = m.id;
        };
        this.captures.append(row);
      }
    }
  }

  updatePip(image: ImageData): void {
    const context = this.pip.getContext('2d')!;
    context.putImageData(image, 0, 0);
  }

  get pipSize(): [number, number] {
    return [this.pip.width, this.pip.height];
  }

  private exportCaptures(): void {
    const data = this.app.device.measurements.map((m) => ({
      id: m.id,
      label: m.label,
      sim_time_s: m.simTime,
      method: m.method,
      sensors: this.app.sensorNames(),
      baseline_raw_ohms: m.baseline.map((row) => Array.from(row)),
      sample_raw_ohms: m.sample.map((row) => Array.from(row)),
      smellprint: Array.from(m.smellprint),
      ground_truth: m.truth,
    }));
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'enose-captures.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }
}
