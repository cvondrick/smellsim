// Library of smell sources: foods, materials, plants, household products and people.
//
// Each source is described by the headspace composition right at its surface (ppm), an emitting
// area, and optional water vapor and heat release. Emission into the room follows a simple
// mass-transfer law: Q = k_m * area * C_headspace, where k_m grows with local air speed.
// Headspace values are rough, order-of-magnitude estimates assembled from flavor/fragrance
// and indoor-air literature, chosen so that relative behavior is plausible.

export type SourceShape =
  | 'mug'
  | 'glass'
  | 'bottle'
  | 'bowl'
  | 'plate'
  | 'vase'
  | 'bin'
  | 'candle'
  | 'books'
  | 'plank'
  | 'plant'
  | 'loaf'
  | 'box'
  | 'cushion'
  | 'container'
  | 'slab'
  | 'bucket'
  | 'can'
  | 'fruit'
  | 'tray'
  | 'rail'
  | 'knob';

export type SourceCategory = 'Food & drink' | 'Materials' | 'Plants & earth' | 'Household' | 'People';

export interface SourceType {
  id: string;
  name: string;
  category: SourceCategory;
  material: string; // material label of the object
  description: string;
  color: string; // visualization color
  shape: SourceShape;
  size: [number, number, number]; // object bounding box w, h, d (m)
  area: number; // emitting surface area (m^2)
  headspace: Record<string, number>; // compound id -> ppm at the surface
  waterPpm: number; // excess water vapor at the surface (ppm)
  heatW: number;
  reservoirMinutes: number; // default depletion time (0 = steady)
}

export const SOURCE_TYPES: SourceType[] = [
  // ---------------------------------------------------------------- Food & drink
  {
    id: 'coffee', name: 'Hot coffee', category: 'Food & drink', material: 'porcelain',
    description: 'Fresh brewed coffee in a mug. Roasty thiols and pyrazines at ppb, plus lots of steam.',
    color: '#c47a3d', shape: 'mug', size: [0.09, 0.1, 0.09], area: 0.006,
    headspace: { furfurylthiol: 0.003, pyrazine: 0.05, diacetyl: 0.3, acetaldehyde: 2, methylbutanal: 0.6, acetic_acid: 0.6, furfural: 0.4 },
    waterPpm: 25000, heatW: 12, reservoirMinutes: 30,
  },
  {
    id: 'red_wine', name: 'Glass of red wine', category: 'Food & drink', material: 'glass',
    description: 'Ethanol dominates the headspace; esters and acetic acid add fruit and sourness.',
    color: '#b3204d', shape: 'glass', size: [0.08, 0.18, 0.08], area: 0.004,
    headspace: { ethanol: 3000, ethyl_acetate: 15, acetic_acid: 3, isoamyl_acetate: 1, acetaldehyde: 2 },
    waterPpm: 1500, heatW: 0, reservoirMinutes: 180,
  },
  {
    id: 'orange', name: 'Peeled orange', category: 'Food & drink', material: 'food-other',
    description: 'Limonene-rich peel oil with linalool and aldehydes.',
    color: '#ff9a1f', shape: 'fruit', size: [0.08, 0.08, 0.08], area: 0.02,
    headspace: { limonene: 40, linalool: 0.4, nonanal: 0.06, ethyl_butyrate: 0.05, acetaldehyde: 0.5 },
    waterPpm: 3000, heatW: 0, reservoirMinutes: 90,
  },
  {
    id: 'banana', name: 'Ripe bananas', category: 'Food & drink', material: 'food-other',
    description: 'Isoamyl acetate gives the classic banana note.',
    color: '#f3d23b', shape: 'fruit', size: [0.18, 0.06, 0.12], area: 0.04,
    headspace: { isoamyl_acetate: 8, ethyl_acetate: 1.5, hexanal: 0.2, ethyl_butyrate: 0.1, acetaldehyde: 0.3 },
    waterPpm: 2000, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'bread', name: 'Fresh bread', category: 'Food & drink', material: 'produce-bread',
    description: 'Ethanol from fermentation plus Maillard crust volatiles like 2-acetyl-1-pyrroline.',
    color: '#d9a35f', shape: 'loaf', size: [0.28, 0.1, 0.13], area: 0.08,
    headspace: { ethanol: 30, acetylpyrroline: 0.0006, methylbutanal: 0.3, furfural: 0.2, hexanal: 0.1, diacetyl: 0.05 },
    waterPpm: 4000, heatW: 0, reservoirMinutes: 120,
  },
  {
    id: 'cheese', name: 'Aged cheese', category: 'Food & drink', material: 'food-other',
    description: 'Short-chain fatty acids (butyric) and sulfur compounds: low thresholds, sticky.',
    color: '#f5d77a', shape: 'slab', size: [0.12, 0.06, 0.1], area: 0.03,
    headspace: { butyric_acid: 0.4, acetic_acid: 0.5, diacetyl: 0.3, methanethiol: 0.01, ethyl_butyrate: 0.1 },
    waterPpm: 1000, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'fish', name: 'Raw fish', category: 'Food & drink', material: 'food-other',
    description: 'Trimethylamine at tens of ppt is already detectable by people.',
    color: '#7fd6e8', shape: 'plate', size: [0.26, 0.04, 0.18], area: 0.04,
    headspace: { trimethylamine: 2, dimethyl_sulfide: 0.2, ammonia: 1, hexanal: 0.05 },
    waterPpm: 2500, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'popcorn', name: 'Buttered popcorn', category: 'Food & drink', material: 'food-other',
    description: 'Diacetyl (butter) and pyrroline/pyrazine roast notes.',
    color: '#ffe9a8', shape: 'bowl', size: [0.22, 0.1, 0.22], area: 0.04,
    headspace: { diacetyl: 0.6, acetylpyrroline: 0.001, pyrazine: 0.02, hexanal: 0.05 },
    waterPpm: 1500, heatW: 4, reservoirMinutes: 40,
  },
  {
    id: 'mint_tea', name: 'Peppermint tea', category: 'Food & drink', material: 'porcelain',
    description: 'Menthol carried by steam.',
    color: '#5fd38d', shape: 'mug', size: [0.09, 0.1, 0.09], area: 0.006,
    headspace: { menthol: 0.6, limonene: 0.2 },
    waterPpm: 22000, heatW: 10, reservoirMinutes: 30,
  },
  {
    id: 'garbage', name: 'Kitchen garbage', category: 'Food & drink', material: 'thermoplastic',
    description: 'Amines, sulfides and acids from decomposing food in a plastic bin.',
    color: '#8d9b3a', shape: 'bin', size: [0.32, 0.55, 0.32], area: 0.07,
    headspace: { trimethylamine: 0.3, dimethyl_sulfide: 0.5, butyric_acid: 0.2, acetic_acid: 1, hydrogen_sulfide: 0.2, methanethiol: 0.05, ethanol: 5 },
    waterPpm: 3000, heatW: 0, reservoirMinutes: 0,
  },

  // ---------------------------------------------------------------- Materials
  {
    id: 'pine_wood', name: 'Pine timber', category: 'Materials', material: 'timber',
    description: 'Fresh softwood off-gasses terpenes, hexanal and acetic acid.',
    color: '#d8b06a', shape: 'plank', size: [0.6, 0.05, 0.15], area: 0.2,
    headspace: { alpha_pinene: 3, limonene: 0.5, hexanal: 0.5, acetic_acid: 0.8, furfural: 0.05 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'old_books', name: 'Old books', category: 'Materials', material: 'paper',
    description: 'Cellulose and lignin degradation: furfural, benzaldehyde, a hint of vanillin.',
    color: '#c9a77c', shape: 'books', size: [0.25, 0.2, 0.18], area: 0.15,
    headspace: { furfural: 0.06, benzaldehyde: 0.03, vanillin: 0.002, hexanal: 0.05, acetic_acid: 0.2, ethylhexanol: 0.02 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'cardboard', name: 'Cardboard box', category: 'Materials', material: 'cardboard',
    description: 'Kraft paper volatiles: furfural, hexanal, acetic acid and residual terpenes.',
    color: '#b98a4e', shape: 'box', size: [0.4, 0.3, 0.3], area: 0.6,
    headspace: { furfural: 0.2, hexanal: 0.3, acetic_acid: 0.5, alpha_pinene: 0.15 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'leather', name: 'Leather chair', category: 'Materials', material: 'leather',
    description: 'Tanning and finishing residues: aldehydes, 2-ethylhexanol, benzothiazole.',
    color: '#8b5a3c', shape: 'cushion', size: [0.5, 0.12, 0.5], area: 0.5,
    headspace: { hexanal: 0.3, nonanal: 0.15, ethylhexanol: 0.3, benzothiazole: 0.05, acetic_acid: 0.3 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'plastic', name: 'Plastic storage bin', category: 'Materials', material: 'thermoplastic',
    description: 'Residual styrene monomer and aromatics from polystyrene/ABS.',
    color: '#5aa9ff', shape: 'container', size: [0.4, 0.25, 0.3], area: 0.5,
    headspace: { styrene: 1.0, ethylbenzene: 0.2, ethylhexanol: 0.1, toluene: 0.1 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'rubber_mat', name: 'Rubber mat', category: 'Materials', material: 'rubber',
    description: 'Vulcanization accelerator residues (benzothiazole) and aromatics.',
    color: '#3c3f47', shape: 'slab', size: [0.6, 0.02, 0.4], area: 0.24,
    headspace: { benzothiazole: 0.4, toluene: 0.3, ethylhexanol: 0.1, isoprene: 0.1 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'polyester', name: 'Polyester cushion', category: 'Materials', material: 'fabric',
    description: 'Low emitter: traces of 2-ethylhexanol, aldehydes and alkanes.',
    color: '#9c7fd1', shape: 'cushion', size: [0.45, 0.12, 0.45], area: 0.4,
    headspace: { ethylhexanol: 0.1, nonanal: 0.08, decane: 0.15 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'brass', name: 'Brass door handle', category: 'Materials', material: 'brass',
    description: 'Metals are odorless; the "metallic" smell is skin lipids oxidized on copper (1-octen-3-one).',
    color: '#d4b04a', shape: 'knob', size: [0.12, 0.06, 0.06], area: 0.01,
    headspace: { octenone: 0.0002, hexanal: 0.005 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'steel', name: 'Steel railing', category: 'Materials', material: 'steel',
    description: 'Practically inert. A useful negative control: the sensor mostly sees the room.',
    color: '#9aa7b4', shape: 'rail', size: [0.8, 0.05, 0.05], area: 0.12,
    headspace: { octenone: 0.00002 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'glass_vase', name: 'Empty glass vase', category: 'Materials', material: 'glass',
    description: 'Inert glass: another negative control.',
    color: '#bfe6ff', shape: 'vase', size: [0.12, 0.25, 0.12], area: 0.08,
    headspace: {},
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'candle', name: 'Vanilla candle (lit)', category: 'Materials', material: 'wax',
    description: 'Fragrance plus paraffin vapor, carried up by the flame plume.',
    color: '#ffd2a1', shape: 'candle', size: [0.08, 0.1, 0.08], area: 0.005,
    headspace: { vanillin: 0.03, decane: 0.5, benzaldehyde: 0.02 },
    waterPpm: 2000, heatW: 40, reservoirMinutes: 0,
  },
  {
    id: 'brick', name: 'Damp brick', category: 'Materials', material: 'brick',
    description: 'Mostly moisture with a trace of geosmin.',
    color: '#b5523b', shape: 'slab', size: [0.3, 0.1, 0.15], area: 0.15,
    headspace: { geosmin: 0.00001 },
    waterPpm: 2500, heatW: 0, reservoirMinutes: 0,
  },

  // ---------------------------------------------------------------- Plants & earth
  {
    id: 'roses', name: 'Vase of roses', category: 'Plants & earth', material: 'flower',
    description: '2-Phenylethanol, linalool and benzyl acetate; green notes from stems.',
    color: '#ff5fa2', shape: 'vase', size: [0.25, 0.45, 0.25], area: 0.15,
    headspace: { phenylethanol: 0.3, linalool: 0.2, benzyl_acetate: 0.1, hexenol: 0.05 },
    waterPpm: 3000, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'houseplant', name: 'Leafy houseplant', category: 'Plants & earth', material: 'foliage',
    description: 'Transpires water; leaves release green-leaf volatiles and a little isoprene.',
    color: '#3fbf5a', shape: 'plant', size: [0.5, 0.9, 0.5], area: 1.2,
    headspace: { hexenol: 0.05, hexenal: 0.03, alpha_pinene: 0.02, linalool: 0.005, isoprene: 0.05 },
    waterPpm: 6000, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'grass', name: 'Fresh-cut grass tray', category: 'Plants & earth', material: 'grass',
    description: 'Wounded leaves burst out (Z)-3-hexenol and (E)-2-hexenal.',
    color: '#8fe34f', shape: 'tray', size: [0.5, 0.06, 0.35], area: 0.18,
    headspace: { hexenol: 0.3, hexenal: 0.15, acetaldehyde: 0.1 },
    waterPpm: 8000, heatW: 0, reservoirMinutes: 60,
  },
  {
    id: 'moss', name: 'Moss and soil', category: 'Plants & earth', material: 'moss',
    description: 'Geosmin and 1-octen-3-ol: earthy, musty, mushroom.',
    color: '#5f7f3a', shape: 'tray', size: [0.4, 0.08, 0.3], area: 0.12,
    headspace: { geosmin: 0.0001, octenol: 0.003 },
    waterPpm: 5000, heatW: 0, reservoirMinutes: 0,
  },

  // ---------------------------------------------------------------- Household
  {
    id: 'nail_polish_remover', name: 'Nail polish remover (open)', category: 'Household', material: 'thermoplastic',
    description: 'An open bottle of acetone: huge headspace, quickly fills the room.',
    color: '#ff7ad9', shape: 'bottle', size: [0.06, 0.14, 0.06], area: 0.0015,
    headspace: { acetone: 15000, ethyl_acetate: 800 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'hand_sanitizer', name: 'Hand sanitizer (open)', category: 'Household', material: 'thermoplastic',
    description: 'Ethanol/isopropanol gel with a citrus fragrance.',
    color: '#9ff0ff', shape: 'bottle', size: [0.06, 0.16, 0.06], area: 0.001,
    headspace: { ethanol: 8000, isopropanol: 500, limonene: 1 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'window_cleaner', name: 'Window cleaner spray', category: 'Household', material: 'thermoplastic',
    description: 'Ammonia and isopropanol. Try the "puffs" pattern for spraying.',
    color: '#45b6ff', shape: 'bottle', size: [0.08, 0.25, 0.06], area: 0.002,
    headspace: { ammonia: 300, isopropanol: 600 },
    waterPpm: 2000, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'pine_cleaner', name: 'Pine floor cleaner', category: 'Household', material: 'thermoplastic',
    description: 'A mop bucket of terpene cleaner. Limonene and pinene react with indoor ozone.',
    color: '#2fa36b', shape: 'bucket', size: [0.3, 0.3, 0.3], area: 0.07,
    headspace: { alpha_pinene: 20, limonene: 12, ethanol: 50 },
    waterPpm: 6000, heatW: 0, reservoirMinutes: 45,
  },
  {
    id: 'paint', name: 'Open paint can', category: 'Household', material: 'steel',
    description: 'Solvent-borne paint: toluene, ethylbenzene and alkanes.',
    color: '#e6e1d3', shape: 'can', size: [0.17, 0.19, 0.17], area: 0.022,
    headspace: { toluene: 300, ethylbenzene: 60, decane: 100, hexane: 50 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 60,
  },
  {
    id: 'perfume', name: 'Floral perfume', category: 'Household', material: 'glass',
    description: 'Ethanol carrier with linalool, limonene, phenylethanol and vanillin.',
    color: '#d68cff', shape: 'bottle', size: [0.06, 0.1, 0.04], area: 0.001,
    headspace: { ethanol: 300, linalool: 3, limonene: 4, phenylethanol: 0.6, benzyl_acetate: 0.5, vanillin: 0.01 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
  {
    id: 'humidifier', name: 'Humidifier', category: 'Household', material: 'thermoplastic',
    description: 'Pure water vapor: invisible to people, but the polymer sensors swell with it.',
    color: '#c6e9ff', shape: 'container', size: [0.22, 0.3, 0.22], area: 0.6,
    headspace: {},
    waterPpm: 60000, heatW: 0, reservoirMinutes: 0,
  },

  // ---------------------------------------------------------------- People
  {
    id: 'human', name: 'Human bioeffluents', category: 'People', material: 'skin',
    description: 'Breath (acetone, isoprene) and skin (acids, ammonia). Emitted by every person.',
    color: '#ffb38a', shape: 'slab', size: [0.4, 1.7, 0.3], area: 1.8,
    headspace: { isoprene: 0.08, acetone: 0.4, butyric_acid: 0.003, acetic_acid: 0.03, ammonia: 0.05, nonanal: 0.002 },
    waterPpm: 0, heatW: 0, reservoirMinutes: 0,
  },
];

export const SOURCE_TYPE_MAP: Record<string, SourceType> = Object.fromEntries(
  SOURCE_TYPES.map((sourceType) => [sourceType.id, sourceType]),
);

export function getSourceType(id: string): SourceType {
  const sourceType = SOURCE_TYPE_MAP[id];
  if (!sourceType) throw new Error(`Unknown source type: ${id}`);
  return sourceType;
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}
