// Prints simulated smellprint magnitudes for source headspaces at contact.
// Run: npx tsx scripts/sensor_check.ts
import { COMPOUNDS, COMPOUND_INDEX, WATER_INDEX, saturationWaterPpm } from '../src/chem/compounds';
import { SOURCE_TYPES } from '../src/chem/sourceTypes';
import { POLYMERS } from '../src/chem/polymers';
import { SensorArray } from '../src/device/sensors';
import { cosineSimilarity } from '../src/device/analysis';

const sensors = new SensorArray();
sensors.setSubstrateTemperature(30);
const ambientWater = 0.4 * saturationWaterPpm(21);
const base = new Float64Array(COMPOUNDS.length);
base[WATER_INDEX] = ambientWater;
const phiBase = Float64Array.from(sensors.equilibrium(base));

function response(ppm: Float64Array): Float64Array {
  sensors.equilibrate(base);
  const r0 = sensors.read();
  sensors.equilibrate(ppm);
  const r1 = sensors.read();
  return Float64Array.from(r0, (v, i) => (r1[i] - v) / v);
}
const prints: Record<string, Float64Array> = {};
for (const type of SOURCE_TYPES) {
  const ppm = Float64Array.from(base);
  for (const [id, value] of Object.entries(type.headspace)) ppm[COMPOUND_INDEX[id]] += value;
  ppm[WATER_INDEX] += type.waterPpm;
  const r = response(ppm);
  prints[type.id] = r;
  let maxI = 0;
  for (let i = 0; i < r.length; i++) if (Math.abs(r[i]) > Math.abs(r[maxI])) maxI = i;
  const mean = r.reduce((s, v) => s + Math.abs(v), 0) / r.length;
  console.log(`${type.id.padEnd(22)} max dR/R ${r[maxI].toExponential(2)} (${POLYMERS[maxI].abbr.padEnd(7)}) mean|dR/R| ${mean.toExponential(2)}`);
}
console.log('baseline phi (water) range', Math.min(...phiBase).toExponential(2), Math.max(...phiBase).toExponential(2));
const ids = ['coffee', 'red_wine', 'pine_wood', 'old_books', 'leather', 'plastic', 'roses', 'fish', 'humidifier'];
console.log('cosine similarity (with humidity):');
console.log('            ' + ids.map((id) => id.slice(0, 7).padStart(8)).join(''));
for (const a of ids) console.log(a.slice(0, 11).padEnd(12) + ids.map((b) => cosineSimilarity(prints[a], prints[b]).toFixed(2).padStart(8)).join(''));
// VOC-only similarity (no water in the sample)
const voc: Record<string, Float64Array> = {};
for (const type of SOURCE_TYPES) {
  const ppm = Float64Array.from(base);
  for (const [id, value] of Object.entries(type.headspace)) ppm[COMPOUND_INDEX[id]] += value;
  voc[type.id] = response(ppm);
}
console.log('cosine similarity (VOC only):');
console.log('            ' + ids.map((id) => id.slice(0, 7).padStart(8)).join(''));
for (const a of ids) console.log(a.slice(0, 11).padEnd(12) + ids.map((b) => cosineSimilarity(voc[a], voc[b]).toFixed(2).padStart(8)).join(''));
