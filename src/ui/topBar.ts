// Top bar: time controls, view modes, layers and camera.

import type { App } from '../app';
import type { VizMode } from '../types';

const SPEEDS = [0.5, 1, 2, 5, 10, 20];

const VIEWS: { mode: VizMode; label: string; title: string }[] = [
  { mode: 'plume', label: 'Plumes', title: 'Each source colored by dilution relative to its own headspace (1 to 1/30,000)' },
  { mode: 'ppm', label: 'ppm', title: 'Absolute concentration on a log scale' },
  { mode: 'oav', label: 'Human nose', title: 'Odor activity value: how many times above the human detection threshold' },
  { mode: 'humidity', label: 'Humidity', title: 'Relative humidity change' },
  { mode: 'temperature', label: 'Temp', title: 'Temperature change (warm plumes rise)' },
  { mode: 'speed', label: 'Air speed', title: 'Air speed' },
];

export class TopBar {
  private app: App;
  private playButton: HTMLButtonElement;
  private clock: HTMLElement;
  private perf: HTMLElement;
  private speedButtons = new Map<number, HTMLButtonElement>();
  private viewButtons = new Map<VizMode, HTMLButtonElement>();
  private cameraButtons = new Map<string, HTMLButtonElement>();
  private particleButton!: HTMLButtonElement;

  constructor(app: App) {
    this.app = app;
    this.playButton = document.getElementById('btn-play') as HTMLButtonElement;
    this.playButton.onclick = () => app.togglePause();
    this.clock = document.getElementById('sim-clock')!;
    this.perf = document.getElementById('sim-perf')!;
    (document.getElementById('btn-skip-1') as HTMLButtonElement).onclick = () => app.sim.skip(60);
    (document.getElementById('btn-skip-10') as HTMLButtonElement).onclick = () => app.sim.skip(600);
    (document.getElementById('btn-reset') as HTMLButtonElement).onclick = () => app.sim.reset();
    (document.getElementById('btn-help') as HTMLButtonElement).onclick = () => app.showHelp(true);

    const speedHost = document.getElementById('speed-buttons')!;
    for (const speed of SPEEDS) {
      const button = document.createElement('button');
      button.textContent = `${speed}x`;
      button.onclick = () => app.setSpeed(speed);
      speedHost.append(button);
      this.speedButtons.set(speed, button);
    }
    const viewHost = document.getElementById('view-buttons')!;
    for (const view of VIEWS) {
      const button = document.createElement('button');
      button.textContent = view.label;
      button.title = view.title;
      button.onclick = () => app.setViewMode(view.mode);
      viewHost.append(button);
      this.viewButtons.set(view.mode, button);
    }
    const layers = document.getElementById('layer-toggles')!;
    const toggle = (label: string, title: string, initial: boolean, onChange: (value: boolean) => void) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.title = title;
      button.classList.toggle('active', initial);
      button.onclick = () => {
        const value = !button.classList.contains('active');
        button.classList.toggle('active', value);
        onChange(value);
      };
      layers.append(button);
      return button;
    };
    toggle('Volume', 'Volumetric fog of the selected view', app.renderer.volume.volumeOn, (value) => (app.renderer.volume.volumeOn = value));
    toggle('Slice', 'Horizontal slice at the chosen height (Visualization settings)', app.renderer.volume.sliceOn, (value) => (app.renderer.volume.sliceOn = value));
    this.particleButton = document.createElement('button');
    this.particleButton.title = 'Tracer particles: odor puffs, air streaks, or off';
    this.particleButton.onclick = () => app.cycleParticles();
    layers.append(this.particleButton);
    toggle('Arrows', 'Air velocity arrows at the slice height', false, (value) => app.setArrows(value));
    toggle('Labels', 'Source labels', true, (value) => app.roomView.setLabelsVisible(value));

    const cameraHost = document.getElementById('camera-buttons')!;
    for (const [mode, label, title] of [
      ['orbit', 'Orbit', 'Dollhouse view: drag to rotate, right-drag to pan, scroll to zoom'],
      ['walk', 'Walk', 'First person with the e-nose in hand (WASD + mouse, Esc to exit)'],
    ] as const) {
      const button = document.createElement('button');
      button.textContent = label;
      button.title = title;
      button.onclick = () => app.setCameraMode(mode);
      cameraHost.append(button);
      this.cameraButtons.set(mode, button);
    }
    this.refresh();
  }

  refresh(): void {
    const app = this.app;
    this.playButton.textContent = app.settings.paused ? 'Play' : 'Pause';
    for (const [speed, button] of this.speedButtons) button.classList.toggle('active', speed === app.settings.speed);
    for (const [mode, button] of this.viewButtons) button.classList.toggle('active', mode === app.settings.vizMode);
    for (const [mode, button] of this.cameraButtons) button.classList.toggle('active', mode === app.cameraMode);
    const particleMode = app.settings.particleMode;
    this.particleButton.textContent = particleMode === 'odor' ? 'Particles: odor' : particleMode === 'air' ? 'Particles: air' : 'Particles: off';
    this.particleButton.classList.toggle('active', particleMode !== 'off');
  }

  updateClock(simTime: number, achievedSpeed: number, stepMs: number): void {
    const hours = Math.floor(simTime / 3600);
    const minutes = Math.floor((simTime % 3600) / 60);
    const seconds = Math.floor(simTime % 60);
    this.clock.textContent = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
    this.perf.textContent = `${achievedSpeed.toFixed(1)}x | ${stepMs.toFixed(1)} ms/step`;
  }
}
