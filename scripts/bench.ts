// Headless benchmark and sanity check of the simulation core.
// Run: npx tsx scripts/bench.ts [presetId] [seconds]
import { PRESETS } from '../src/room/presets';
import { World } from '../src/sim/world';
import type { SimSettings } from '../src/types';
import { COMPOUNDS } from '../src/chem/compounds';

const presetId = process.argv[2] ?? 'studio';
const seconds = Number(process.argv[3] ?? 60);
const preset = PRESETS.find((candidate) => candidate.id === presetId)!;
const layout = preset.build();
const settings: SimSettings = {
  paused: false, speed: 1, vizMode: 'plume', vizSource: '', plumeDecades: 3.5, subtractBackground: true, ppmLogMin: -4, ppmLogMax: 3,
  particleMode: 'odor', particleCount: 8000, sendVelocity: false, turbulence: 0.05,
  vorticity: 0.4, eddyDiffusivity: 0.002, pressureIters: 20,
};
const world = new World(layout, settings);
const g = world.grid;
console.log(`${layout.name}: grid ${g.nx}x${g.ny}x${g.nz} = ${g.n} cells, fluid ${world.fluid.fluidCount}, scalars ${world.fluid.scalars.length}, sources ${world.sources.length}`);
world.probes = [{ id: 'center', x: layout.room.width / 2, y: 1.2, z: layout.room.depth / 2 }];
const dt = 0.1;
const t0 = performance.now();
let steps = 0;
while (world.time < seconds) {
  world.step(dt);
  steps++;
}
const ms = (performance.now() - t0) / steps;
console.log(`step ${ms.toFixed(2)} ms  -> ${(dt * 1000 / ms).toFixed(1)}x realtime at dt=${dt}`);
const c0 = performance.now();
world.composite();
console.log(`composite ${(performance.now() - c0).toFixed(1)} ms`);
const stats = world.stats();
for (let s = 0; s < world.sources.length; s++) {
  const src = world.sources[s];
  let actual = 0;
  for (const ch of src.channels) actual += world.fluid.total(ch.field.data) * world.fluid.cellVolume;
  console.log(`${src.info.name.padEnd(32)} emitted ${stats.emitted[s].toExponential(2)} mL  airborne ${stats.airborne[s].toExponential(2)} actual ${actual.toExponential(2)} decayed ${stats.decayed[s].toExponential(2)} filtered ${stats.filtered[s].toExponential(2)} reservoir ${stats.reservoir[s].toFixed(2)}`);
}
console.log(`mean T ${stats.meanTempC.toFixed(2)} C, RH ${stats.meanRH.toFixed(1)} %, max speed ${stats.maxSpeed.toFixed(2)} m/s`);
let nan = 0;
for (const f of world.fluid.scalars) for (const x of f.data) if (!Number.isFinite(x)) nan++;
for (const x of world.fluid.u) if (!Number.isFinite(x)) nan++;
console.log(`non-finite values: ${nan}`);
const out = new Float32Array(world.probeStride * world.probeIds().length);
world.sampleAllProbes(out, 0);
const top = COMPOUNDS.map((c, i) => [c.id, out[i]] as [string, number]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('center probe top compounds (ppm):', top.map(([id, v]) => `${id}=${v.toExponential(2)}`).join(' '));
