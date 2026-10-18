// Main-thread handle on the simulation worker.

import type { FrameMsg, FromWorker, Layout, ProbeSpec, ReadyMsg, SimSettings, ToWorker } from '../types';

export class SimClient {
  private worker: Worker;
  ready: ReadyMsg | null = null;
  onReady: ((message: ReadyMsg) => void) | null = null;
  onFrame: ((message: FrameMsg) => void) | null = null;

  constructor(layout: Layout, settings: SimSettings) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === 'ready') {
        this.ready = message;
        this.onReady?.(message);
      } else if (message.type === 'frame') {
        // Frames computed before the latest layout may carry a stale probe layout; the stride
        // check in consumers guards against that.
        this.onFrame?.(message);
      }
    };
    this.send({ type: 'init', layout, settings });
  }

  private send(message: ToWorker): void {
    this.worker.postMessage(message);
  }

  setLayout(layout: Layout): void {
    this.send({ type: 'layout', layout });
  }

  updateSettings(settings: Partial<SimSettings>): void {
    this.send({ type: 'settings', settings });
  }

  setProbes(probes: ProbeSpec[]): void {
    this.send({ type: 'probes', probes });
  }

  reset(): void {
    this.send({ type: 'reset' });
  }

  skip(seconds: number): void {
    this.send({ type: 'skip', seconds });
  }

  refill(sourceId: string): void {
    this.send({ type: 'refill', sourceId });
  }
}
