// Diagnoses which sources dominate the plume visualization after some time.
import { PRESETS } from '../src/room/presets';
import { World } from '../src/sim/world';
import type { SimSettings } from '../src/types';

const settings: SimSettings = {
  paused: false, speed: 1, vizMode: 'plume', vizSource: '', plumeDecades: 3, subtractBackground: true, ppmLogMin: -4, ppmLogMax: 3,
  particleMode: 'off', particleCount: 0, sendVelocity: false, turbulence: 0.05, vorticity: 0.4, eddyDiffusivity: 0.002, pressureIters: 20,
};
const world = new World(PRESETS.find((p) => p.id === (process.argv[2] ?? 'studio'))!.build(), settings);
const seconds = Number(process.argv[3] ?? 100);
while (world.time < seconds) world.step(0.2);
const fluid = world.fluid;
for (const source of world.sources) {
  const reference = source.channels.reduce((sum, ch) => sum + ch.headspace, 0);
  let visible = 0;
  let maxRel = 0;
  let meanRel = 0;
  for (const idx of fluid.fluidCells) {
    let c = 0;
    for (const ch of source.channels) c += ch.field.data[idx];
    const rel = c / reference;
    meanRel += rel;
    maxRel = Math.max(maxRel, rel);
    if (Math.log10(rel) + 3 > 0.15 * 3) visible++;
  }
  meanRel /= fluid.fluidCount;
  console.log(`${source.info.name.padEnd(30)} ref ${reference.toExponential(2)} meanRel ${meanRel.toExponential(2)} maxRel ${maxRel.toExponential(2)} visibleCells ${(100 * visible / fluid.fluidCount).toFixed(1)}%`);
}
const t = world.temperature.data;
let maxT = 0;
for (const idx of fluid.fluidCells) maxT = Math.max(maxT, t[idx]);
console.log('max dT', maxT.toFixed(2), 'mean dT', fluid.mean(t).toFixed(2));
