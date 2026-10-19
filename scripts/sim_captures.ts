// Generates simulated e-nose captures that follow the New York Smells capture distribution:
// material mix from the dataset, snout touching the object, side-inlet baseline, 18 baseline and
// 16 sample rows, fitted per-material chemistry (src/chem/nysCalibration.json) with
// object-to-object variability, and ambient conditions spanning the dataset's range.
// Run: npx tsx scripts/sim_captures.ts [count] [out.json] [profile: nys|literature]
import fs from 'node:fs';
import calibration from '../src/chem/nysCalibration.json';
import { COMPOUNDS, COMPOUND_INDEX, WATER_INDEX, saturationWaterPpm } from '../src/chem/compounds';
import { getSourceType } from '../src/chem/sourceTypes';
import { Cyranose, type Method } from '../src/device/cyranose';
import type { ProfileId } from '../src/device/profiles';

const count = Number(process.argv[2] ?? 1500);
const outPath = process.argv[3] ?? '/tmp/sim_nys/sim.json';
const profile = (process.argv[4] ?? 'nys') as ProfileId;
const targets = JSON.parse(fs.readFileSync('data/nys_targets.json', 'utf8'));
const NEAR = 0.8;

let seed = 99;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());

// material frequencies from the training split; inert materials have no emission
type Entry = { material: string; weight: number; sources: string[]; vocScale: number; waterPpm: number; tempC: number };
const fitted = calibration.materials as Record<string, { simSources: string[]; vocScale: number; waterPpm: number; tempC: number }>;
const train = targets.splits.train;
const entries: Entry[] = [{ material: 'inert', weight: train.inert_n, sources: [], vocScale: 0, waterPpm: 0, tempC: 0 }];
for (const [material, info] of Object.entries(train.materials as Record<string, { n: number }>)) {
  const fit = fitted[material];
  if (!fit) continue;
  entries.push({ material, weight: info.n, sources: fit.simSources, vocScale: fit.vocScale, waterPpm: fit.waterPpm, tempC: fit.tempC });
}
const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
const pick = () => {
  let r = random() * totalWeight;
  for (const entry of entries) {
    r -= entry.weight;
    if (r <= 0) return entry;
  }
  return entries[0];
};

const method: Method = {
  name: 'NYS-like',
  phases: [
    { kind: 'baseline', label: 'Baseline', duration: 11.25, flow: 120 },
    { kind: 'sample', label: 'Sample', duration: 10, flow: 120 },
    { kind: 'purge', label: 'Purge', duration: 10, flow: 180 },
  ],
  substrateTempC: 30,
  sampleRateHz: 1.6,
  intakeFilter: false,
};

const device = new Cyranose();
device.setProfile(profile);
device.setMethod(method);
// optional overrides for tuning the nuisance model: WANDER_GAIN, WANDER_SNOUT, NOISE_GAIN
const sensorProfile = device.sensors.profile;
if (sensorProfile.nuisance?.wander) {
  const wander = sensorProfile.nuisance.wander;
  if (process.env.WANDER_GAIN) wander.amplitudeLogMedian += Math.log(Number(process.env.WANDER_GAIN));
  if (process.env.WANDER_SNOUT) wander.snoutFactor = Number(process.env.WANDER_SNOUT);
}
if (process.env.NOISE_GAIN) for (const channel of sensorProfile.channels) if (channel.kind === 'active') channel.noise *= Number(process.env.NOISE_GAIN);
const truth = { nearestSourceId: '', nearestSourceName: '', distance: 0, topCompounds: [], rh: 0, tempC: 0 };
const records: { baseline: number[][]; sample: number[][]; smellprint: number[]; rh: number; label: string }[] = [];
let time = 0;
for (let n = 0; n < count; n++) {
  const entry = pick();
  const tempC = 19 + random() * 9.5;
  const waterAmbient = Math.min(0.9 * saturationWaterPpm(tempC), 4500 * Math.exp(random() * Math.log(17000 / 4500)));
  const ambient = new Float32Array(COMPOUNDS.length);
  ambient[WATER_INDEX] = waterAmbient;
  ambient[COMPOUND_INDEX['ethanol']] = 0.02 + random() * 0.1;
  ambient[COMPOUND_INDEX['acetone']] = 0.01 + random() * 0.03;
  const snout = Float32Array.from(ambient);
  // object-to-object variability around the fitted class chemistry
  const vocScale = entry.vocScale * Math.exp(0.7 * gaussian());
  for (const sourceId of entry.sources) {
    for (const [id, ppm] of Object.entries(getSourceType(sourceId).headspace)) {
      snout[COMPOUND_INDEX[id]] += (NEAR * ppm * vocScale) / entry.sources.length;
    }
  }
  snout[WATER_INDEX] = Math.max(0, snout[WATER_INDEX] + entry.waterPpm * Math.exp(0.5 * gaussian()));
  const side = { ppm: ambient, tempC };
  const inlet = { ppm: snout, tempC: tempC + entry.tempC };
  for (let s = 0; s < 150; s++) {
    time += 0.1;
    device.advance(time, side, side, truth);
  }
  device.startCycle(entry.material, '#fff');
  while (device.mode === 'cycle') {
    time += 0.1;
    device.advance(time, inlet, side, truth);
  }
  const m = device.measurements[device.measurements.length - 1];
  records.push({
    baseline: m.baseline.map((row) => Array.from(row)),
    sample: m.sample.map((row) => Array.from(row)),
    smellprint: Array.from(m.smellprint),
    rh: (100 * waterAmbient) / saturationWaterPpm(tempC),
    label: entry.material,
  });
  device.measurements = [];
}
fs.mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(records));
console.log(`wrote ${records.length} captures (${profile} profile) to ${outPath}`);
