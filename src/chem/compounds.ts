// Odorant compound database.
//
// Values are approximate literature values intended for a qualitative simulator:
//   - Abraham solvation descriptors (E, S, A, B, L) drive polymer/vapor partitioning (LSER).
//   - Odor thresholds (ot, ppm) are rounded from published compilations (e.g. Nagata 2003);
//     individual thresholds vary by an order of magnitude between people and studies.
//   - kO3 is the gas-phase rate constant with ozone (cm^3 molecule^-1 s^-1).
//   - vd is an effective surface deposition / sorption velocity (m/s).
//   - pidRF is a 10.6 eV photoionization detector response factor (null = not detected).

export interface Compound {
  id: string;
  name: string;
  mw: number; // g/mol
  density: number; // g/mL of the condensed phase, used for molar volume
  E: number;
  S: number;
  A: number;
  B: number;
  L: number;
  ot: number; // human odor detection threshold, ppm (Infinity = odorless)
  descriptor: string;
  kO3: number;
  vd: number;
  pidRF: number | null;
}

const c = (
  id: string,
  name: string,
  mw: number,
  density: number,
  [E, S, A, B, L]: [number, number, number, number, number],
  ot: number,
  descriptor: string,
  kO3: number,
  vd: number,
  pidRF: number | null,
): Compound => ({ id, name, mw, density, E, S, A, B, L, ot, descriptor, kO3, vd, pidRF });

export const COMPOUNDS: Compound[] = [
  c('water', 'Water vapor', 18.02, 1.0, [0.0, 0.45, 0.82, 0.35, 0.26], Infinity, 'odorless', 0, 0, null),
  c('ethanol', 'Ethanol', 46.07, 0.789, [0.246, 0.42, 0.37, 0.48, 1.485], 0.52, 'alcoholic', 0, 5e-6, 10),
  c('isopropanol', 'Isopropanol', 60.1, 0.786, [0.212, 0.36, 0.33, 0.56, 1.764], 26, 'rubbing alcohol', 0, 5e-6, 6),
  c('acetone', 'Acetone', 58.08, 0.784, [0.179, 0.7, 0.04, 0.49, 1.696], 42, 'sweet solvent', 0, 2e-6, 1.1),
  c('ethyl_acetate', 'Ethyl acetate', 88.11, 0.902, [0.106, 0.62, 0.0, 0.45, 2.314], 0.87, 'fruity solvent', 0, 2e-6, 4.6),
  c('toluene', 'Toluene', 92.14, 0.867, [0.601, 0.52, 0.0, 0.14, 3.325], 0.33, 'paint thinner', 0, 1e-6, 0.5),
  c('styrene', 'Styrene', 104.15, 0.906, [0.849, 0.65, 0.0, 0.16, 3.856], 0.035, 'sweet plastic', 1.7e-17, 2e-6, 0.4),
  c('ethylbenzene', 'Ethylbenzene', 106.17, 0.867, [0.613, 0.51, 0.0, 0.15, 3.778], 0.17, 'gasoline', 0, 1e-6, 0.5),
  c('hexane', 'Hexane', 86.18, 0.655, [0.0, 0.0, 0.0, 0.0, 2.668], 1.5, 'gasoline', 0, 1e-6, 4.3),
  c('decane', 'Decane', 142.3, 0.73, [0.0, 0.0, 0.0, 0.0, 4.686], 0.62, 'waxy, kerosene', 0, 3e-6, 1.4),
  c('limonene', 'd-Limonene', 136.24, 0.841, [0.519, 0.36, 0.0, 0.22, 4.688], 0.038, 'citrus', 2.1e-16, 3e-6, 0.7),
  c('alpha_pinene', 'alpha-Pinene', 136.24, 0.858, [0.446, 0.14, 0.0, 0.12, 4.308], 0.018, 'pine, woody', 8.7e-17, 3e-6, 0.4),
  c('linalool', 'Linalool', 154.25, 0.858, [0.398, 0.55, 0.2, 0.67, 4.794], 0.0015, 'floral, lavender', 4.3e-16, 1e-5, 0.8),
  c('phenylethanol', '2-Phenylethanol', 122.17, 1.02, [0.811, 0.91, 0.3, 0.64, 4.628], 0.01, 'rose', 0, 2e-5, 1.0),
  c('benzyl_acetate', 'Benzyl acetate', 150.17, 1.054, [0.798, 1.06, 0.0, 0.65, 5.082], 0.0016, 'jasmine', 0, 2e-5, 1.0),
  c('vanillin', 'Vanillin', 152.15, 1.06, [1.04, 1.62, 0.32, 0.73, 5.4], 0.0002, 'vanilla', 0, 1e-4, 1.2),
  c('isoamyl_acetate', 'Isoamyl acetate', 130.19, 0.876, [0.051, 0.57, 0.0, 0.47, 3.74], 0.006, 'banana', 0, 3e-6, 2.0),
  c('ethyl_butyrate', 'Ethyl butyrate', 116.16, 0.879, [0.068, 0.58, 0.0, 0.45, 3.271], 0.00004, 'pineapple, fruity', 0, 3e-6, 1.5),
  c('hexanal', 'Hexanal', 100.16, 0.814, [0.146, 0.65, 0.0, 0.45, 3.357], 0.00028, 'grassy, rancid', 0, 8e-6, 1.5),
  c('nonanal', 'Nonanal', 142.24, 0.827, [0.15, 0.65, 0.0, 0.45, 4.856], 0.00034, 'waxy, orange peel', 0, 1e-5, 1.5),
  c('hexenal', '(E)-2-Hexenal', 98.14, 0.846, [0.27, 0.73, 0.0, 0.47, 3.4], 0.017, 'green leaf', 2e-18, 1e-5, 1.5),
  c('hexenol', '(Z)-3-Hexenol', 100.16, 0.85, [0.3, 0.48, 0.37, 0.48, 3.4], 0.07, 'cut grass', 6.4e-17, 1e-5, 2.0),
  c('furfural', 'Furfural', 96.08, 1.16, [0.69, 1.13, 0.0, 0.45, 3.318], 0.05, 'bready, almond', 0, 1e-5, 1.0),
  c('benzaldehyde', 'Benzaldehyde', 106.12, 1.044, [0.82, 1.0, 0.0, 0.39, 4.008], 0.042, 'almond, cherry', 0, 8e-6, 1.0),
  c('acetaldehyde', 'Acetaldehyde', 44.05, 0.788, [0.208, 0.67, 0.0, 0.45, 1.23], 0.0015, 'green apple, pungent', 0, 3e-6, 6),
  c('diacetyl', 'Diacetyl', 86.09, 0.99, [0.24, 0.8, 0.0, 0.62, 2.0], 0.00005, 'buttery', 0, 5e-6, 1.5),
  c('acetic_acid', 'Acetic acid', 60.05, 1.049, [0.265, 0.64, 0.62, 0.44, 1.75], 0.006, 'vinegar, sour', 0, 1e-4, 22),
  c('butyric_acid', 'Butyric acid', 88.11, 0.96, [0.21, 0.62, 0.6, 0.45, 2.75], 0.00019, 'cheesy, sweaty', 0, 1e-4, 3),
  c('trimethylamine', 'Trimethylamine', 59.11, 0.63, [0.14, 0.2, 0.0, 0.67, 1.62], 0.000032, 'fishy', 0, 1e-4, 0.9),
  c('ammonia', 'Ammonia', 17.03, 0.68, [0.139, 0.35, 0.14, 0.62, 0.68], 1.5, 'pungent, sharp', 0, 1e-4, 9.4),
  c('dimethyl_sulfide', 'Dimethyl sulfide', 62.13, 0.846, [0.404, 0.33, 0.0, 0.29, 2.237], 0.003, 'cabbage', 0, 3e-6, 0.5),
  c('hydrogen_sulfide', 'Hydrogen sulfide', 34.08, 0.94, [0.35, 0.31, 0.1, 0.07, 0.723], 0.00041, 'rotten egg', 0, 5e-5, 3.3),
  c('methanethiol', 'Methanethiol', 48.11, 0.87, [0.35, 0.33, 0.0, 0.2, 1.6], 0.00007, 'rotten cabbage', 0, 2e-5, 0.6),
  c('furfurylthiol', '2-Furfurylthiol', 114.17, 1.13, [0.9, 0.85, 0.05, 0.45, 3.9], 0.00001, 'roasted coffee', 0, 2e-5, 1.0),
  c('pyrazine', '2-Ethyl-3,5-dimethylpyrazine', 136.2, 0.96, [0.7, 0.85, 0.0, 0.65, 4.4], 0.00004, 'roasty, nutty', 0, 1e-5, 1.0),
  c('methylbutanal', '3-Methylbutanal', 86.13, 0.8, [0.144, 0.62, 0.0, 0.45, 2.62], 0.0001, 'malty', 0, 5e-6, 1.5),
  c('acetylpyrroline', '2-Acetyl-1-pyrroline', 111.14, 1.0, [0.6, 0.9, 0.0, 0.7, 3.6], 0.00002, 'bread crust, popcorn', 0, 2e-5, 1.0),
  c('isoprene', 'Isoprene', 68.12, 0.681, [0.313, 0.23, 0.0, 0.1, 2.101], 0.048, 'faint rubbery', 1.27e-17, 1e-6, 0.6),
  c('menthol', 'Menthol', 156.27, 0.89, [0.4, 0.5, 0.23, 0.58, 5.2], 0.04, 'minty', 0, 3e-5, 1.0),
  c('eugenol', 'Eugenol', 164.2, 1.06, [0.946, 0.99, 0.22, 0.51, 5.8], 0.0006, 'clove, spicy', 0, 5e-5, 1.0),
  c('benzothiazole', 'Benzothiazole', 135.19, 1.24, [1.4, 1.1, 0.0, 0.46, 5.15], 0.0006, 'rubber', 0, 3e-5, 0.9),
  c('ethylhexanol', '2-Ethylhexanol', 130.23, 0.833, [0.209, 0.39, 0.37, 0.48, 4.433], 0.13, 'musty plastic', 0, 1e-5, 1.9),
  c('octenol', '1-Octen-3-ol', 128.21, 0.837, [0.25, 0.42, 0.37, 0.48, 4.3], 0.0001, 'mushroom', 1e-16, 2e-5, 2.0),
  c('octenone', '1-Octen-3-one', 126.2, 0.83, [0.2, 0.7, 0.0, 0.5, 4.0], 0.000003, 'metallic', 1e-17, 2e-5, 1.5),
  c('geosmin', 'Geosmin', 182.3, 1.0, [0.7, 0.65, 0.32, 0.75, 6.2], 0.0000065, 'earthy, petrichor', 0, 1e-4, 1.0),
  c('formaldehyde', 'Formaldehyde', 30.03, 0.815, [0.22, 0.7, 0.0, 0.33, 0.73], 0.5, 'pungent', 0, 3e-5, null),
  c('indole', 'Indole', 117.15, 1.22, [1.2, 1.12, 0.44, 0.22, 5.5], 0.0003, 'animalic, floral', 0, 5e-5, 1.0),
];

export const COMPOUND_INDEX: Record<string, number> = Object.fromEntries(
  COMPOUNDS.map((compound, index) => [compound.id, index]),
);

export const WATER_INDEX = COMPOUND_INDEX['water'];

/** Molar density of air at ~22 C and 1 atm (mol/m^3). 1 ppm = 41.4 umol/m^3. */
export const AIR_MOLAR_DENSITY = 41.4;

/** Liquid molar volume (m^3/mol). */
export function molarVolume(compound: Compound): number {
  return (compound.mw / compound.density) * 1e-6;
}

/** Saturation water vapor mixing ratio (ppm) at temperature T (C), Magnus formula. */
export function saturationWaterPpm(tempC: number): number {
  const pSatHpa = 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
  return (pSatHpa / 1013.25) * 1e6;
}

/** Relative humidity (%) from absolute water vapor ppm and temperature. */
export function relativeHumidity(waterPpm: number, tempC: number): number {
  return (100 * waterPpm) / saturationWaterPpm(tempC);
}

/** First-order loss rate (1/s) of a compound by ozone chemistry and surface uptake. */
export function decayRate(compound: Compound, ozonePpb: number, areaToVolume: number, surfaceUptake: number): number {
  const ozoneMolecPerCm3 = ozonePpb * 2.46e10;
  return compound.kO3 * ozoneMolecPerCm3 + compound.vd * areaToVolume * surfaceUptake;
}

/** Fraction of a compound retained per pass by a filter. */
export function filterEfficiency(compound: Compound, filter: 'none' | 'hepa' | 'carbon'): number {
  if (filter !== 'carbon' || compound.id === 'water') return 0;
  // Activated carbon adsorbs large, polarizable molecules well and small polar ones poorly.
  const affinity = Math.min(1, Math.max(0.1, (compound.L - 0.6) / 3.2));
  return 0.92 * affinity;
}
