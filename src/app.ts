// Application: wires the simulation worker, 3D views, the e-nose and the UI together.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { COMPOUNDS, WATER_INDEX, relativeHumidity } from './chem/compounds';
import { Adaptation, intensityFromOav } from './chem/perception';
import { POLYMERS } from './chem/polymers';
import { getSourceType, SOURCE_TYPE_MAP } from './chem/sourceTypes';
import { Cyranose, pidReading, type GroundTruth } from './device/cyranose';
import { DeviceView, SNOUT_TIP_LOCAL } from './render/deviceView';
import { PeopleView } from './render/peopleView';
import { Renderer } from './render/renderer';
import { RoomView } from './render/roomView';
import { FlowArrows, ParticlesView } from './render/vizViews';
import { cloneLayout } from './room/layoutUtils';
import { PRESETS } from './room/presets';
import { buildGrid, buildWalkable, snapRoom, type Grid } from './room/voxelize';
import { SimClient } from './sim/client';
import { PROBE_EXTRA, type FanItem, type FrameMsg, type FrameStats, type Layout, type PersonItem, type ReadyMsg, type SimSettings, type SourceInfo, type VizMode } from './types';
import { DevicePanel, type SnoutReadout } from './ui/devicePanel';
import { Editor } from './ui/editor';
import { HELP_HTML } from './ui/help';
import { LeftPanel } from './ui/leftPanel';
import { TopBar } from './ui/topBar';

const DEFAULT_SETTINGS: SimSettings = {
  paused: false,
  speed: 2,
  vizMode: 'plume',
  vizSource: '',
  plumeDecades: 4,
  subtractBackground: true,
  ppmLogMin: -4,
  ppmLogMax: 3,
  particleMode: 'odor',
  particleCount: 12000,
  sendVelocity: false,
  turbulence: 0.05,
  vorticity: 0.4,
  eddyDiffusivity: 0.002,
  pressureIters: 20,
};

const PLEASANT = new Set(['coffee', 'red_wine', 'orange', 'banana', 'bread', 'popcorn', 'mint_tea', 'pine_wood', 'old_books', 'leather', 'candle', 'roses', 'houseplant', 'grass', 'moss', 'perfume', 'pine_cleaner', 'hand_sanitizer']);

/** Same oscillation law as the worker, for drawing fan heads. */
function fanDirection(fan: FanItem, time: number): [number, number, number] {
  const yaw = fan.yaw + (fan.oscillate ? fan.oscAmplitude * Math.sin((2 * Math.PI * time) / Math.max(1, fan.oscPeriod)) : 0);
  return [Math.sin(yaw) * Math.cos(fan.pitch), Math.sin(fan.pitch), Math.cos(yaw) * Math.cos(fan.pitch)];
}

export class App {
  layout: Layout;
  presetId: string | null = 'studio';
  settings: SimSettings = { ...DEFAULT_SETTINGS };
  readonly renderer: Renderer;
  readonly roomView = new RoomView();
  readonly peopleView = new PeopleView();
  readonly particlesView = new ParticlesView();
  readonly flowArrows = new FlowArrows();
  readonly deviceView = new DeviceView();
  readonly device = new Cyranose();
  readonly sim: SimClient;
  readonly orbit: OrbitControls;
  private pointerLock: PointerLockControls;
  cameraMode: 'orbit' | 'walk' = 'orbit';
  readonly editor: Editor;
  private topBar: TopBar;
  private leftPanel: LeftPanel;
  private devicePanel: DevicePanel;
  particleStyle = { size: 7 };
  sources: SourceInfo[] = [];
  private grid: Grid;
  private walkable: Uint8Array;
  readonly devicePose = { position: new THREE.Vector3(2, 1, 2), yaw: 0, pitch: -0.6 };
  private lastProbeKey = '';
  private simTime = 0;
  private achievedSpeed = 0;
  private stepMs = 0;
  private stats: FrameStats | null = null;
  private latestSnout: Float32Array | null = null;
  private latestNoses = new Map<string, Float32Array>();
  private operatorNose = new Adaptation();
  private peopleNoses = new Map<string, Adaptation>();
  private lastSpoke = new Map<string, number>();
  private lastPerceptionTime = 0;
  private humanReadout: SnoutReadout['human'] = [];
  private keys = new Set<string>();
  private walkReach = 0.42;
  private commitTimer: number | null = null;
  private lastUiUpdate = 0;
  private lastPip = 0;
  private realTime = 0;
  private timer = new THREE.Timer();
  private hint: HTMLElement;
  private legendOverlay: HTMLElement;

  constructor() {
    this.layout = PRESETS[0].build();
    const viewport = document.getElementById('viewport')!;
    this.hint = document.getElementById('viewport-hint')!;
    this.legendOverlay = document.getElementById('legend')!;
    this.renderer = new Renderer(viewport);
    const scene = this.renderer.scene;
    scene.add(this.roomView.group, this.peopleView.group, this.deviceView.group, this.deviceView.locator, this.particlesView.points, this.flowArrows.mesh);
    this.flowArrows.mesh.visible = false;

    const camera = this.renderer.camera;
    this.orbit = new OrbitControls(camera, this.renderer.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.screenSpacePanning = false;
    this.pointerLock = new PointerLockControls(camera, this.renderer.renderer.domElement);
    this.pointerLock.addEventListener('unlock', () => {
      if (this.cameraMode === 'walk') this.setCameraMode('orbit');
    });

    this.grid = buildGrid(this.layout);
    this.walkable = buildWalkable(this.grid);
    this.sim = new SimClient(cloneLayout(this.layout), this.settings);
    this.sim.onReady = (message) => this.onReady(message);
    this.sim.onFrame = (message) => this.onFrame(message);

    this.editor = new Editor(this);
    this.topBar = new TopBar(this);
    this.leftPanel = new LeftPanel(document.getElementById('left-panel')!, this);
    this.devicePanel = new DevicePanel(document.getElementById('right-panel')!, this);
    this.device.onMeasurement = () => {
      this.devicePanel.selectedMeasurement = null;
    };

    this.applyLayoutViews();
    this.frameCamera();
    this.placeDeviceInitially();
    this.leftPanel.setPresetInfo(this.layout, this.presetId);
    this.setHint(null);
    this.applyParticleStyle();
    this.updateLegendOverlay();

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    this.renderer.renderer.domElement.addEventListener('wheel', (event) => {
      if (this.cameraMode === 'walk') this.walkReach = Math.min(0.8, Math.max(0.25, this.walkReach + event.deltaY * 0.0005));
    });
    document.getElementById('help-modal')!.innerHTML = `<div class="content">${HELP_HTML}<p><button id="help-close" class="primary">Close</button></p></div>`;
    document.getElementById('help-close')!.onclick = () => this.showHelp(false);
    document.getElementById('help-modal')!.onclick = (event) => {
      if (event.target === event.currentTarget) this.showHelp(false);
    };

    this.renderer.renderer.setAnimationLoop(() => this.tick());
  }

  // ------------------------------------------------------------------ layout

  loadPreset(id: string): void {
    const preset = PRESETS.find((candidate) => candidate.id === id);
    if (!preset) return;
    this.presetId = id;
    this.loadLayout(preset.build(), id);
  }

  loadLayout(layout: Layout, presetId: string | null = null): void {
    this.layout = layout;
    this.presetId = presetId;
    snapRoom(this.layout);
    this.editor.select(null);
    this.settings.vizSource = '';
    this.device.measurements = [];
    this.commitLayout(true);
    this.frameCamera();
    this.placeDeviceInitially();
    this.leftPanel.setPresetInfo(this.layout, presetId);
  }

  /** Send the layout to the simulation and rebuild the views. */
  commitLayout(roomChanged = false): void {
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    if (roomChanged) snapRoom(this.layout);
    this.sendLayoutToSim();
    this.applyLayoutViews();
    if (roomChanged) this.leftPanel.buildRoomGui();
  }

  /** Debounced commit for slider drags. */
  commitLayoutSoon(): void {
    if (this.commitTimer !== null) clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      this.commitTimer = null;
      this.commitLayout();
    }, 120);
  }

  sendLayoutToSim(): void {
    this.sim.setLayout(cloneLayout(this.layout));
  }

  private applyLayoutViews(): void {
    this.grid = buildGrid(this.layout);
    this.walkable = buildWalkable(this.grid);
    this.roomView.build(this.layout, fanDirection);
    this.peopleView.sync(this.layout.items.filter((item): item is PersonItem => item.type === 'person'));
    this.editor.refreshAttachment();
    this.devicePanel?.refreshProbeTargets(this.layout);
  }

  objectForItem(id: string): THREE.Object3D | undefined {
    const view = this.roomView.views.get(id);
    if (view) return view.object;
    let found: THREE.Object3D | undefined;
    this.peopleView.group.children.forEach((child) => {
      if (child.userData.itemId === id) found = child;
    });
    return found;
  }

  onSelectionChanged(id: string | null): void {
    const item = id && id !== 'device' ? this.layout.items.find((candidate) => candidate.id === id) ?? null : null;
    this.leftPanel.showSelection(id === 'device' ? 'device' : item);
    if (!this.editor.placing) this.leftPanel.clearPaletteSelection();
  }

  saveLayout(): void {
    const blob = new Blob([JSON.stringify(this.layout, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${this.layout.name.replace(/\s+/g, '-').toLowerCase()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // ------------------------------------------------------------------ camera & device pose

  private frameCamera(): void {
    const { width, depth, height } = this.layout.room;
    const extent = Math.max(width, depth);
    this.orbit.target.set(width / 2, 0, depth / 2);
    this.renderer.camera.position.set(width / 2 - extent * 0.1, height + extent * 0.95, depth + extent * 0.75);
    this.orbit.update();
    this.renderer.volume.sliceY = Math.min(1.2, height * 0.5);
  }

  private placeDeviceInitially(): void {
    const firstSource = this.layout.items.find((item) => item.type === 'source');
    if (firstSource) this.probeSource(firstSource.id, 0.12);
    else this.moveDeviceToRoomCenter();
  }

  moveDeviceToRoomCenter(): void {
    this.devicePose.position.set(this.layout.room.width / 2, 1.2, this.layout.room.depth / 2);
    this.devicePose.pitch = -0.3;
    this.applyDevicePose();
  }

  /** Put the snout tip just above an object, with the device body toward the camera. */
  probeSource(id: string, gap = 0.012): void {
    const item = this.layout.items.find((candidate) => candidate.id === id);
    if (!item || item.type !== 'source') return;
    const type = getSourceType(item.sourceType);
    const top = new THREE.Vector3(item.x, item.y + type.size[1] + gap, item.z);
    const camera = this.renderer.camera.position;
    const yaw = Math.atan2(camera.x - item.x, camera.z - item.z);
    this.devicePose.yaw = yaw;
    this.devicePose.pitch = -0.75;
    const rotation = new THREE.Euler(this.devicePose.pitch, yaw, 0, 'YXZ');
    const offset = SNOUT_TIP_LOCAL.clone().applyEuler(rotation);
    this.devicePose.position.copy(top).sub(offset);
    if (this.cameraMode === 'walk') this.setCameraMode('orbit');
    this.applyDevicePose();
  }

  applyDevicePose(): void {
    const group = this.deviceView.group;
    group.position.copy(this.devicePose.position);
    group.rotation.set(this.devicePose.pitch, this.devicePose.yaw, 0, 'YXZ');
    group.updateMatrixWorld(true);
    this.updateProbes();
  }

  /** Called while the user drags the device gizmo. */
  onDeviceMoved(): void {
    const group = this.deviceView.group;
    const room = this.layout.room;
    group.position.x = Math.min(room.width - 0.05, Math.max(0.05, group.position.x));
    group.position.y = Math.min(room.height - 0.05, Math.max(0.03, group.position.y));
    group.position.z = Math.min(room.depth - 0.05, Math.max(0.05, group.position.z));
    this.devicePose.position.copy(group.position);
    const euler = new THREE.Euler().setFromQuaternion(group.quaternion, 'YXZ');
    this.devicePose.yaw = euler.y;
    this.devicePose.pitch = euler.x;
    group.updateMatrixWorld(true);
    this.updateProbes();
  }

  private updateProbes(): void {
    const snout = this.deviceView.snoutTipWorld();
    const side = this.deviceView.sideInletWorld();
    const key = [snout.x, snout.y, snout.z, side.x, side.y, side.z].map((value) => value.toFixed(3)).join(',');
    if (key === this.lastProbeKey) return;
    this.lastProbeKey = key;
    this.sim.setProbes([
      { id: 'snout', x: snout.x, y: snout.y, z: snout.z },
      { id: 'side', x: side.x, y: side.y, z: side.z },
    ]);
  }

  setCameraMode(mode: 'orbit' | 'walk'): void {
    if (mode === this.cameraMode) return;
    this.cameraMode = mode;
    const camera = this.renderer.camera;
    if (mode === 'walk') {
      this.editor.select(null);
      this.editor.startPlacing(null);
      this.orbit.enabled = false;
      const target = this.orbit.target;
      const start = this.nearestWalkable(target.x, target.z);
      camera.position.set(start[0], 1.6, start[1]);
      camera.rotation.set(0, 0, 0, 'YXZ');
      // look horizontally toward the farther half of the room
      const towardX = this.layout.room.width - start[0] > start[0] ? 1 : -1;
      camera.lookAt(start[0] + towardX * 4, 1.35, start[1]);
      this.pointerLock.lock();
      if (this.roomView.ceiling) this.roomView.ceiling.visible = true;
    } else {
      this.pointerLock.unlock();
      this.orbit.enabled = true;
      this.frameCamera();
    }
    this.setHint(null);
    this.topBar.refresh();
  }

  private nearestWalkable(x: number, z: number): [number, number] {
    const { nx, nz, h } = this.grid;
    let best: [number, number] = [x, z];
    let bestDistance = Infinity;
    for (let k = 1; k < nz - 1; k++) {
      for (let i = 1; i < nx - 1; i++) {
        if (!this.walkable[i + nx * k]) continue;
        const cx = (i - 0.5) * h;
        const cz = (k - 0.5) * h;
        const distance = (cx - x) ** 2 + (cz - z) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = [cx, cz];
        }
      }
    }
    return best;
  }

  private isWalkable(x: number, z: number): boolean {
    const { nx, nz, h } = this.grid;
    const i = Math.floor(x / h + 1);
    const k = Math.floor(z / h + 1);
    if (i < 1 || k < 1 || i > nx - 2 || k > nz - 2) return false;
    return this.walkable[i + nx * k] === 1;
  }

  private updateWalk(dt: number): void {
    const camera = this.renderer.camera;
    const speed = (this.keys.has('ShiftLeft') ? 2.4 : 1.3) * dt;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(forward);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(forward);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      const next = camera.position.clone().add(move);
      if (this.isWalkable(next.x, next.z)) camera.position.copy(next);
      else if (this.isWalkable(next.x, camera.position.z)) camera.position.x = next.x;
      else if (this.isWalkable(camera.position.x, next.z)) camera.position.z = next.z;
    }
    if (this.keys.has('KeyQ')) camera.position.y = Math.max(0.6, camera.position.y - dt);
    if (this.keys.has('KeyE')) camera.position.y = Math.min(this.layout.room.height - 0.2, camera.position.y + dt);
    // device held in front of the camera, snout slightly down
    const holdOffset = new THREE.Vector3(0.12, -0.15, -this.walkReach + 0.08);
    const position = holdOffset.applyQuaternion(camera.quaternion).add(camera.position);
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.devicePose.position.copy(position);
    this.devicePose.yaw = euler.y;
    this.devicePose.pitch = euler.x - 0.12;
    this.applyDevicePose();
  }

  setHint(text: string | null): void {
    if (text) {
      this.hint.textContent = text;
      return;
    }
    this.hint.innerHTML =
      this.cameraMode === 'walk'
        ? 'Walk: <span class="kbd">WASD</span> move, mouse look, <span class="kbd">Q</span>/<span class="kbd">E</span> crouch/rise, scroll = arm reach, <span class="kbd">Space</span> measure, <span class="kbd">Esc</span> exit'
        : 'Drag to orbit, right-drag to pan, scroll to zoom. Click the e-nose to move it (gizmo), click objects to edit. <span class="kbd">Space</span> measure, <span class="kbd">L</span> live sniff';
  }

  showHelp(visible: boolean): void {
    document.getElementById('help-modal')!.classList.toggle('hidden', !visible);
  }

  // ------------------------------------------------------------------ settings

  pushSettings(): void {
    this.sim.updateSettings({ ...this.settings });
    this.topBar.refresh();
    this.updateLegendOverlay();
  }

  togglePause(): void {
    this.settings.paused = !this.settings.paused;
    this.pushSettings();
  }

  setSpeed(speed: number): void {
    this.settings.speed = speed;
    this.settings.paused = false;
    this.pushSettings();
  }

  setViewMode(mode: VizMode): void {
    this.settings.vizMode = mode;
    this.pushSettings();
  }

  cycleParticles(): void {
    const order = ['odor', 'air', 'off'] as const;
    this.settings.particleMode = order[(order.indexOf(this.settings.particleMode) + 1) % order.length];
    this.applyParticleStyle();
    this.pushSettings();
  }

  applyParticleStyle(): void {
    this.particlesView.setMode(this.settings.particleMode, this.particleStyle.size);
  }

  setArrows(visible: boolean): void {
    this.settings.sendVelocity = visible;
    this.flowArrows.mesh.visible = visible;
    this.flowArrows.height = this.renderer.volume.sliceY;
    this.pushSettings();
  }

  private updateLegendOverlay(): void {
    const mode = this.settings.vizMode;
    const scales: Record<VizMode, [string, string, string, string]> = {
      plume: ['linear-gradient(90deg, transparent, #ffffff)', `1/${Math.round(10 ** this.settings.plumeDecades).toLocaleString()} of headspace`, 'headspace', 'Plume dilution (per-source color)'],
      ppm: ['linear-gradient(90deg, transparent, #ffffff)', `10^${this.settings.ppmLogMin} ppm`, `10^${this.settings.ppmLogMax} ppm`, 'Concentration (per-source color)'],
      oav: ['linear-gradient(90deg, transparent, #ffffff)', 'threshold', '3000x threshold', 'What a person would smell'],
      humidity: ['linear-gradient(90deg, #e6be78, transparent, #3caaff)', '-12% RH', '+12% RH', 'Humidity change'],
      temperature: ['linear-gradient(90deg, #4696ff, transparent, #ff6e3c)', '-3 C', '+3 C', 'Temperature change'],
      speed: ['linear-gradient(90deg, transparent, #2878ff, #ffe14d)', '0', '1.5 m/s', 'Air speed'],
    };
    const [gradient, low, high, title] = scales[mode];
    const solo = this.settings.vizSource ? this.sources.find((source) => source.id === this.settings.vizSource) : null;
    const backgroundNote = this.settings.subtractBackground && (mode === 'plume' || mode === 'ppm') ? '<div class="muted">above the room-average level</div>' : '';
    this.legendOverlay.innerHTML = `<div>${title}${solo ? ` - only <b>${solo.name}</b>` : ''}</div>${backgroundNote}<div class="scale" style="background:${gradient}"></div><div class="ends"><span>${low}</span><span>${high}</span></div>`;
  }

  // ------------------------------------------------------------------ measurement

  runMeasurement(): void {
    if (this.device.mode === 'cycle') return;
    if (this.device.mode === 'live') this.device.toggleLive();
    const truth = this.device.lastTruth;
    const near = truth && truth.distance < 0.08 && truth.nearestSourceId;
    const label = near ? truth.nearestSourceName : 'Room air';
    const source = near ? this.sources.find((candidate) => candidate.id === truth.nearestSourceId) : null;
    const color = source ? `rgb(${source.color.map((c) => Math.round(c * 255)).join(',')})` : '#9aa4b1';
    this.device.startCycle(label, color);
  }

  toggleLive(): void {
    this.device.toggleLive();
  }

  sensorNames(): string[] {
    return POLYMERS.map((polymer) => polymer.abbr);
  }

  // ------------------------------------------------------------------ worker messages

  private onReady(message: ReadyMsg): void {
    this.sources = message.sources;
    const { nx, ny, nz, h, roomSize } = message.grid;
    this.renderer.setRoom(roomSize, [nx - 2, ny - 2, nz - 2], h);
    this.particlesView.setColors(message.sources.map((source) => source.color));
    this.latestSnout = null;
    this.updateLegendOverlay();
  }

  private onFrame(message: FrameMsg): void {
    if (!this.sim.ready) return;
    this.simTime = message.simTime;
    this.achievedSpeed = message.achievedSpeed;
    this.stepMs = message.stepMs;
    this.stats = message.stats;
    if (message.volume) this.renderer.updateVolume(message.volume);
    if (message.particles && this.settings.particleMode !== 'off') this.particlesView.update(message.particles);
    this.peopleView.applyFrame(message.peopleIds, message.people);
    if (message.velocity && message.velocityDims && this.flowArrows.mesh.visible) {
      this.flowArrows.update(message.velocity, message.velocityDims, this.sim.ready.grid.h);
    }

    const nC = COMPOUNDS.length;
    const nS = this.sources.length;
    const stride = nC + PROBE_EXTRA + 2 * nS;
    if (message.probeStride !== stride) return; // frame from before the latest layout
    const nProbes = message.probeIds.length;
    const snoutIndex = message.probeIds.indexOf('snout');
    const sideIndex = message.probeIds.indexOf('side');
    for (let sample = 0; sample < message.sampleTimes.length; sample++) {
      const base = sample * nProbes * stride;
      if (snoutIndex < 0 || sideIndex < 0) break;
      const snout = message.probeData.subarray(base + snoutIndex * stride, base + (snoutIndex + 1) * stride);
      const side = message.probeData.subarray(base + sideIndex * stride, base + (sideIndex + 1) * stride);
      this.device.advance(
        message.sampleTimes[sample],
        { ppm: snout.subarray(0, nC), tempC: snout[nC + 1] },
        { ppm: side.subarray(0, nC), tempC: side[nC + 1] },
        this.truthFrom(snout),
      );
      this.latestSnout = snout;
    }
    const last = message.sampleTimes.length - 1;
    if (last >= 0) {
      const base = last * nProbes * stride;
      message.probeIds.forEach((id, index) => {
        if (id.startsWith('nose:')) this.latestNoses.set(id.slice(5), message.probeData.subarray(base + index * stride, base + (index + 1) * stride));
      });
      this.updatePerception(message.simTime);
    }
  }

  private truthFrom(probe: Float32Array): GroundTruth {
    const nC = COMPOUNDS.length;
    const nearestIndex = probe[nC + 4];
    const source = nearestIndex >= 0 ? this.sources[nearestIndex] : undefined;
    const compounds: { id: string; ppm: number }[] = [];
    for (let j = 0; j < nC; j++) if (j !== WATER_INDEX && probe[j] > 1e-6) compounds.push({ id: COMPOUNDS[j].id, ppm: probe[j] });
    compounds.sort((a, b) => b.ppm - a.ppm);
    return {
      nearestSourceId: source?.id ?? '',
      nearestSourceName: source?.name ?? 'ambient air',
      distance: probe[nC + 3],
      topCompounds: compounds.slice(0, 6),
      rh: relativeHumidity(probe[WATER_INDEX], probe[nC + 1]),
      tempC: probe[nC + 1],
    };
  }

  /** Human perception at the snout (operator) and at every person's nose. */
  private updatePerception(simTime: number): void {
    const dt = Math.min(5, Math.max(0, simTime - this.lastPerceptionTime));
    this.lastPerceptionTime = simTime;
    if (dt <= 0) return;
    const nC = COMPOUNDS.length;
    const nS = this.sources.length;
    const oavOffset = nC + PROBE_EXTRA + nS;
    if (this.latestSnout) {
      const entries: SnoutReadout['human'] = [];
      this.sources.forEach((source, index) => {
        const raw = intensityFromOav(this.latestSnout![oavOffset + index]);
        const adapted = this.operatorNose.update(source.id, raw, dt);
        if (adapted > 0.05) {
          const type = SOURCE_TYPE_MAP[source.typeId];
          const descriptor = type ? this.dominantDescriptor(source.typeId) : '';
          entries.push({ name: source.name, color: `rgb(${source.color.map((c) => Math.round(c * 255)).join(',')})`, intensity: raw, adapted, descriptor });
        }
      });
      entries.sort((a, b) => b.adapted - a.adapted);
      this.humanReadout = entries.slice(0, 5);
    }
    for (const [personId, probe] of this.latestNoses) {
      let nose = this.peopleNoses.get(personId);
      if (!nose) {
        nose = new Adaptation();
        this.peopleNoses.set(personId, nose);
      }
      let best: { source: SourceInfo; intensity: number } | null = null;
      this.sources.forEach((source, index) => {
        const ownScent = source.id.startsWith(`${personId}:`) || source.id === 'people';
        const adapted = nose!.update(source.id, intensityFromOav(probe[oavOffset + index]), dt);
        if (!ownScent && adapted > 1.6 && (!best || adapted > best.intensity)) best = { source, intensity: adapted };
      });
      const found = best as { source: SourceInfo; intensity: number } | null;
      if (found && simTime - (this.lastSpoke.get(personId) ?? -1e9) > 45 && !this.peopleView.isSpeaking(personId, this.realTime)) {
        this.lastSpoke.set(personId, simTime);
        const name = found.source.name.toLowerCase();
        const pleasant = PLEASANT.has(found.source.typeId);
        const strong = found.intensity > 3;
        const text = pleasant ? (strong ? `Wow, ${name}!` : `Mmm... ${name}?`) : strong ? `Ugh, ${name}!` : `Is that ${name}?`;
        this.peopleView.say(personId, text, this.realTime);
      }
    }
  }

  private dominantDescriptor(typeId: string): string {
    const type = SOURCE_TYPE_MAP[typeId];
    if (!type) return '';
    let best = '';
    let bestOav = 0;
    for (const [compoundId, ppm] of Object.entries(type.headspace)) {
      const compound = COMPOUNDS.find((candidate) => candidate.id === compoundId);
      if (!compound || !isFinite(compound.ot)) continue;
      const oav = ppm / compound.ot;
      if (oav > bestOav) {
        bestOav = oav;
        best = compound.descriptor;
      }
    }
    return best;
  }

  private snoutReadout(): SnoutReadout | null {
    const probe = this.latestSnout;
    if (!probe) return null;
    const nC = COMPOUNDS.length;
    const truth = this.truthFrom(probe);
    const nearest = this.sources.find((source) => source.id === truth.nearestSourceId);
    const compounds: { index: number; ppm: number }[] = [];
    for (let j = 0; j < nC; j++) if (j !== WATER_INDEX && probe[j] > 1e-6) compounds.push({ index: j, ppm: probe[j] });
    compounds.sort((a, b) => b.ppm - a.ppm);
    return {
      nearestName: truth.distance < 0.6 && nearest ? nearest.name : 'nothing nearby',
      nearestColor: nearest ? `rgb(${nearest.color.map((c) => Math.round(c * 255)).join(',')})` : '#9aa4b1',
      distance: truth.distance,
      rh: truth.rh,
      tempC: truth.tempC,
      speed: probe[nC + 2],
      pidPpb: pidReading(probe.subarray(0, nC)),
      compounds: compounds.slice(0, 7),
      human: this.humanReadout,
    };
  }

  // ------------------------------------------------------------------ input & loop

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    this.keys.add(event.code);
    if (event.code === 'Space') {
      event.preventDefault();
      this.runMeasurement();
    } else if (event.code === 'KeyL') {
      this.toggleLive();
    } else if (event.code === 'KeyP') {
      this.togglePause();
    } else if (event.code === 'KeyT' && this.cameraMode === 'orbit') {
      this.editor.select('device');
    }
  }

  private tick(): void {
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    this.realTime += dt;
    if (this.cameraMode === 'walk') this.updateWalk(dt);
    else this.orbit.update();
    if (this.roomView.ceiling) this.roomView.ceiling.visible = this.cameraMode === 'walk';
    this.roomView.update(this.realTime, this.simTime, this.settings.paused ? 0 : dt * this.settings.speed);
    this.peopleView.update(dt, this.realTime);
    this.deviceView.pump = this.device.pneumatics.inlet;
    this.deviceView.rig.visible = this.cameraMode === 'orbit';
    this.deviceView.locator.visible = this.cameraMode === 'orbit';
    this.deviceView.update(this.realTime);
    this.editor.update();

    if (this.realTime - this.lastUiUpdate > 0.12) {
      this.lastUiUpdate = this.realTime;
      const readout = this.snoutReadout();
      this.devicePanel.update(readout);
      const snoutPerSource = this.latestSnout ? this.latestSnout.subarray(COMPOUNDS.length + PROBE_EXTRA, COMPOUNDS.length + PROBE_EXTRA + this.sources.length) : null;
      this.leftPanel.updateLegend(this.sources, this.stats, snoutPerSource);
      this.topBar.updateClock(this.simTime, this.achievedSpeed, this.stepMs);
      this.updateDeviceScreen(readout);
    }
    this.renderer.render(this.realTime);
    if (this.realTime - this.lastPip > 0.35) {
      this.lastPip = this.realTime;
      const [width, height] = this.devicePanel.pipSize;
      this.devicePanel.updatePip(this.renderer.renderView(this.deviceView.camera, width, height));
    }
  }

  private updateDeviceScreen(readout: SnoutReadout | null): void {
    const device = this.device;
    const phase = device.currentPhase;
    const last = device.measurements[device.measurements.length - 1];
    const lines: string[] = [];
    if (last) {
      lines.push(`#${last.id} ${last.label.slice(0, 17)}`);
      if (last.match) lines.push(`~${last.match.label.slice(0, 12)} ${last.match.similarity.toFixed(2)}`);
    }
    if (readout) lines.push(`RH ${readout.rh.toFixed(0)}%  ${readout.tempC.toFixed(1)}C`);
    this.deviceView.drawScreen({
      title: 'CYRANOSE 320',
      status: device.mode === 'live' ? 'LIVE SNIFF' : phase ? phase.label.toUpperCase().slice(0, 18) : 'READY',
      progress: device.mode === 'cycle' ? device.cycleElapsed / device.cycleDuration : -1,
      lines,
      pump: device.pneumatics.inlet,
    });
  }
}
