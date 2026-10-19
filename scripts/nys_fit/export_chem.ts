// Exports the simulator's chemistry (compounds, polymers, source headspaces) for the Python fit.
// Run: npx tsx scripts/nys_fit/export_chem.ts data/sim_chem.json
import fs from 'node:fs';
import { COMPOUNDS, molarVolume } from '../../src/chem/compounds';
import { POLYMERS } from '../../src/chem/polymers';
import { SOURCE_TYPES } from '../../src/chem/sourceTypes';

const out = process.argv[2] ?? 'data/sim_chem.json';
const chem = {
  compounds: COMPOUNDS.map((c) => ({ id: c.id, E: c.E, S: c.S, A: c.A, B: c.B, L: c.L, molarVolume: molarVolume(c), enthalpy: c.id === 'water' ? -44e3 : -(20e3 + 8e3 * c.L) })),
  polymers: POLYMERS.map((p) => ({ abbr: p.abbr, family: p.family, lser: p.lser, percolationMargin: p.percolationMargin })),
  sources: SOURCE_TYPES.map((s) => ({ id: s.id, material: s.material, headspace: s.headspace, waterPpm: s.waterPpm })),
};
fs.writeFileSync(out, JSON.stringify(chem, null, 1));
console.log(`wrote ${out}: ${chem.compounds.length} compounds, ${chem.polymers.length} polymers, ${chem.sources.length} sources`);
