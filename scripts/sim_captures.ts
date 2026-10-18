// Generates simulated e-nose captures under New-York-Smells-like conditions for comparison with
// real data: snout touching the object, ambient baseline through the side inlet, mostly materials.
// Run: npx tsx scripts/sim_captures.ts [count] [out.json]
import fs from 'node:fs';
import { COMPOUNDS, COMPOUND_INDEX, WATER_INDEX, saturationWaterPpm } from '../src/chem/compounds';
import { SOURCE_TYPES } from '../src/chem/sourceTypes';
import { Cyranose, type Method } from '../src/device/cyranose';

const count = Number(process.argv[2] ?? 800);
const outPath = process.argv[3] ?? '/tmp/sim_nys/sim.json';

let seed = 99;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

// Real dataset material mix is dominated by plastics, steel, paper, wood, foliage and glass.
const weights: Record<string, number> = {
  plastic: 9, steel: 8, old_books: 4, cardboard: 3, pine_wood: 4, houseplant: 4, glass_vase: 4, roses: 2, brass: 1.5,
  leather: 1.5, polyester: 2, rubber_mat: 1, brick: 1, moss: 1, grass: 1, bread: 0.7, orange: 0.4, banana: 0.4, coffee: 0.4, candle: 0.4,
};
const pool = SOURCE_TYPES.filter((type) => weights[type.id]);
const totalWeight = pool.reduce((sum, type) => sum + weights[type.id], 0);
const pick = () => {
  let r = random() * totalWeight;
  for (const type of pool) {
    r -= weights[type.id];
    if (r <= 0) return type;
  }
  return pool[0];
};

const method: Method = {
  name: 'NYS-like',
  phases: [
    { kind: 'baseline', label: 'Baseline', duration: 11, flow: 120 },
    { kind: 'sample', label: 'Sample', duration: 10, flow: 120 },
    { kind: 'purge', label: 'Purge', duration: 10, flow: 180 },
  ],
  substrateTempC: 30,
  sampleRateHz: 1.6,
  intakeFilter: false,
};

const device = new Cyranose();
device.setMethod(method);
const truth = { nearestSourceId: '', nearestSourceName: '', distance: 0, topCompounds: [], rh: 0, tempC: 0 };
const records: { baseline: number[][]; sample: number[][]; smellprint: number[]; rh: number; label: string }[] = [];
let time = 0;
for (let n = 0; n < count; n++) {
  const type = pick();
  const tempC = 16 + random() * 13;
  const rh = 13 + random() * 45;
  const ambient = new Float32Array(COMPOUNDS.length);
  ambient[WATER_INDEX] = (rh / 100) * saturationWaterPpm(tempC);
  // a little urban/indoor background VOC
  ambient[COMPOUND_INDEX['ethanol']] = 0.02 + random() * 0.1;
  ambient[COMPOUND_INDEX['acetone']] = 0.01 + random() * 0.03;
  ambient[COMPOUND_INDEX['toluene']] = random() * 0.01;
  const distance = random() * 0.01; // 0-1 cm: touching the object
  const near = Math.exp(-distance / 0.025);
  const snout = Float32Array.from(ambient);
  for (const [id, ppm] of Object.entries(type.headspace)) snout[COMPOUND_INDEX[id]] += near * ppm;
  snout[WATER_INDEX] += near * type.waterPpm;
  const side = { ppm: ambient, tempC };
  const inlet = { ppm: snout, tempC };
  // idle on ambient air between captures
  for (let s = 0; s < 150; s++) {
    time += 0.1;
    device.advance(time, side, side, truth);
  }
  device.startCycle(type.material, type.color);
  while (device.mode === 'cycle') {
    time += 0.1;
    device.advance(time, inlet, side, truth);
  }
  const m = device.measurements[device.measurements.length - 1];
  records.push({
    baseline: m.baseline.map((row) => Array.from(row)),
    sample: m.sample.map((row) => Array.from(row)),
    smellprint: Array.from(m.smellprint),
    rh,
    label: type.material,
  });
  device.measurements = [];
}
fs.mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(records));
console.log(`wrote ${records.length} captures to ${outPath}`);
