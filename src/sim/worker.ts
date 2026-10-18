/// <reference lib="webworker" />
// Simulation worker: steps the world at the requested speed and streams frames to the main thread.

import { COMPOUNDS } from '../chem/compounds';
import type { FrameMsg, ReadyMsg, SimSettings, ToWorker } from '../types';
import { World } from './world';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let world: World | null = null;
let settings: SimSettings;
let lastTick = performance.now();
let simTarget = 0;
let lastFrameAt = 0;
let lastVolumeAt = 0;
let lastVelocityAt = 0;
let lastFrameSimTime = 0;
let lastFrameRealTime = performance.now();
let achievedSpeed = 0;
let stepMsAverage = 0;
let skipRemaining = 0;
let volumeDirty = true;
let sampleTimes: number[] = [];
let probeChunks: Float32Array[] = [];
let lastDt = 0.1;

function chooseDt(speed: number): number {
  return Math.min(0.25, Math.max(0.06, speed * 0.04));
}

function postReady(): void {
  if (!world) return;
  const grid = world.grid;
  const message: ReadyMsg = {
    type: 'ready',
    grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz, h: grid.h, roomSize: grid.roomSize },
    sources: world.sourceInfos(),
    compoundIds: COMPOUNDS.map((compound) => compound.id),
  };
  // Probe layout changes with the source list; drop samples recorded with the old layout.
  sampleTimes = [];
  probeChunks = [];
  volumeDirty = true;
  scope.postMessage(message);
}

function recordProbes(): void {
  if (!world) return;
  const count = world.probeIds().length;
  const chunk = new Float32Array(count * world.probeStride);
  world.sampleAllProbes(chunk, 0);
  sampleTimes.push(world.time);
  probeChunks.push(chunk);
}

function stepOnce(dt: number, record: boolean): void {
  if (!world) return;
  const start = performance.now();
  world.step(dt);
  lastDt = dt;
  const elapsed = performance.now() - start;
  stepMsAverage = stepMsAverage === 0 ? elapsed : stepMsAverage * 0.9 + elapsed * 0.1;
  volumeDirty = true;
  if (record) recordProbes();
}

function sendFrame(now: number): void {
  if (!world) return;
  if (sampleTimes.length === 0) recordProbes();
  const probeIds = world.probeIds();
  const stride = world.probeStride;
  const probeData = new Float32Array(probeChunks.length * probeIds.length * stride);
  probeChunks.forEach((chunk, index) => probeData.set(chunk, index * probeIds.length * stride));
  const times = Float64Array.from(sampleTimes);
  sampleTimes = [];
  probeChunks = [];

  let particles: Float32Array | null = null;
  const system = world.particles;
  if (settings.particleMode !== 'off' && system.count > 0) {
    particles = new Float32Array(system.count * 4);
    for (let index = 0; index < system.count; index++) {
      particles[index * 4] = system.positions[index * 3];
      particles[index * 4 + 1] = system.positions[index * 3 + 1];
      particles[index * 4 + 2] = system.positions[index * 3 + 2];
      particles[index * 4 + 3] = system.attributes[index];
    }
  }

  let volume: Uint8Array | null = null;
  if (volumeDirty && now - lastVolumeAt > 60) {
    volume = world.composite();
    lastVolumeAt = now;
    volumeDirty = false;
  }

  let velocity: Float32Array | null = null;
  let velocityDims: [number, number, number] | null = null;
  if (settings.sendVelocity && now - lastVelocityAt > 200) {
    const snapshot = world.velocitySnapshot();
    velocity = snapshot.data;
    velocityDims = snapshot.dims;
    lastVelocityAt = now;
  }

  const realElapsed = (now - lastFrameRealTime) / 1000;
  if (realElapsed > 0) {
    const instantaneous = (world.time - lastFrameSimTime) / realElapsed;
    achievedSpeed = achievedSpeed * 0.85 + instantaneous * 0.15;
  }
  lastFrameRealTime = now;
  lastFrameSimTime = world.time;

  const message: FrameMsg = {
    type: 'frame',
    simTime: world.time,
    achievedSpeed,
    stepMs: stepMsAverage,
    dt: lastDt,
    sampleTimes: times,
    probeIds,
    probeStride: stride,
    probeData,
    people: world.peopleBuffer(),
    peopleIds: world.people.people.map((person) => person.id),
    particles,
    volume,
    velocity,
    velocityDims,
    stats: world.stats(),
  };
  const transfer: Transferable[] = [probeData.buffer, times.buffer, message.people.buffer];
  if (particles) transfer.push(particles.buffer);
  if (volume) transfer.push(volume.buffer);
  if (velocity) transfer.push(velocity.buffer);
  scope.postMessage(message, transfer);
}

function tick(): void {
  const now = performance.now();
  const realDt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  let steps = 0;
  if (world) {
    if (skipRemaining > 0) {
      while (skipRemaining > 0 && performance.now() - now < 45) {
        stepOnce(0.25, false);
        skipRemaining -= 0.25;
        steps++;
      }
      simTarget = world.time;
    } else if (!settings.paused) {
      const dt = chooseDt(settings.speed);
      simTarget += realDt * settings.speed;
      if (simTarget - world.time > dt * 4) simTarget = world.time + dt * 4;
      while (world.time + dt <= simTarget && performance.now() - now < 30) {
        stepOnce(dt, true);
        steps++;
      }
    } else {
      simTarget = world.time;
    }
    if (now - lastFrameAt >= 33) {
      sendFrame(performance.now());
      lastFrameAt = now;
    }
  }
  setTimeout(tick, steps > 0 ? 0 : 4);
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      settings = { ...message.settings };
      world = new World(message.layout, settings);
      simTarget = world.time;
      postReady();
      setTimeout(tick, 0);
      break;
    case 'layout':
      if (!world) return;
      world.setLayout(message.layout);
      simTarget = world.time;
      postReady();
      break;
    case 'settings': {
      Object.assign(settings, message.settings);
      if (world && (message.settings.particleCount !== undefined || message.settings.particleMode !== undefined)) {
        world.particles.configure(settings.particleCount, settings.particleMode, world.fluid);
      }
      volumeDirty = true;
      break;
    }
    case 'probes':
      if (!world) return;
      if (world.probes.length !== message.probes.length) {
        sampleTimes = [];
        probeChunks = [];
      }
      world.probes = message.probes;
      break;
    case 'reset':
      if (!world) return;
      world.reset();
      simTarget = 0;
      lastFrameSimTime = 0;
      volumeDirty = true;
      break;
    case 'skip':
      skipRemaining += message.seconds;
      break;
    case 'refill':
      world?.refill(message.sourceId);
      break;
  }
};
