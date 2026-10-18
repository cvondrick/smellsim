// The 32-element carbon-black/polymer chemiresistor array.
//
// The commercial NoseChip polymer set is proprietary. This set is a plausible stand-in drawn from
// the Caltech (Lewis group) carbon-black composite literature and from polymers whose vapor
// partitioning has been characterized with linear solvation energy relationships (LSER):
//
//   log10 K = c + e*E + s*S + a*A + b*B + l*L
//
// where K = C_polymer / C_gas and (E, S, A, B, L) are the vapor's Abraham descriptors.
// Coefficients are approximate (rounded literature values where available, chemically
// motivated estimates otherwise). "a" pairs with vapor acidity, so H-bond basic polymers
// (PEO, PVP, PEI) have large a; H-bond acidic polymers (fluoroalcohols) have large b.

export type PolymerFamily = 'nonpolar' | 'aromatic' | 'dipolar' | 'basic' | 'acidic' | 'hydrophilic';

export interface Polymer {
  name: string;
  abbr: string;
  family: PolymerFamily;
  lser: [number, number, number, number, number, number]; // c, e, s, a, b, l
  tau: number; // sorption time constant (s); glassy polymers are slower
  percolationMargin: number; // (v0 - vc) / vc, smaller = closer to threshold = more sensitive
  baseResistance: number; // ohms
}

const p = (
  name: string,
  abbr: string,
  family: PolymerFamily,
  lser: [number, number, number, number, number, number],
  tau: number,
  percolationMargin: number,
  baseResistance: number,
): Polymer => ({ name, abbr, family, lser, tau, percolationMargin, baseResistance });

export const POLYMERS: Polymer[] = [
  p('Polyisobutylene', 'PIB', 'nonpolar', [-0.77, -0.08, 0.37, 0.18, 0.0, 1.02], 0.8, 0.45, 18e3),
  p('Poly(dimethylsiloxane)', 'PDMS', 'nonpolar', [-0.5, -0.1, 0.25, 0.3, 0.0, 0.86], 0.6, 0.6, 24e3),
  p('Polybutadiene', 'PBD', 'nonpolar', [-0.8, 0.1, 0.5, 0.4, 0.0, 1.0], 0.9, 0.5, 15e3),
  p('Poly(ethylene-co-vinyl acetate)', 'PEVA', 'nonpolar', [-0.85, 0.0, 0.9, 1.0, 0.0, 0.95], 1.1, 0.55, 30e3),
  p('Poly(isoprene)', 'PIP', 'nonpolar', [-0.75, 0.05, 0.42, 0.3, 0.0, 0.98], 0.9, 0.7, 21e3),
  p('Polystyrene', 'PS', 'aromatic', [-0.9, 0.5, 0.9, 0.3, 0.2, 0.9], 3.5, 0.5, 42e3),
  p('Poly(alpha-methylstyrene)', 'PaMS', 'aromatic', [-0.95, 0.4, 0.8, 0.3, 0.1, 0.92], 3.8, 0.65, 55e3),
  p('Poly(phenylmethylsiloxane)', 'OV-25', 'aromatic', [-0.85, 0.18, 1.29, 0.56, 0.44, 0.88], 0.8, 0.5, 19e3),
  p('Poly(bisphenol A carbonate)', 'PC', 'aromatic', [-1.3, 0.4, 1.3, 1.0, 0.5, 0.8], 4.5, 0.6, 61e3),
  p('Polysulfone', 'PSF', 'aromatic', [-1.5, 0.4, 1.7, 1.6, 0.2, 0.75], 5.0, 0.55, 75e3),
  p('Poly(styrene-co-maleic anhydride)', 'PSMA', 'aromatic', [-1.4, 0.3, 1.8, 1.4, 0.3, 0.75], 4.2, 0.6, 66e3),
  p('Poly(epichlorohydrin)', 'PECH', 'dipolar', [-0.75, 0.1, 1.63, 1.45, 0.71, 0.83], 1.0, 0.4, 27e3),
  p('Poly(trifluoropropylmethylsiloxane)', 'OV-202', 'dipolar', [-0.39, -0.48, 1.3, 0.44, 0.71, 0.81], 0.7, 0.55, 22e3),
  p('Poly(methyl methacrylate)', 'PMMA', 'dipolar', [-1.2, 0.0, 1.4, 1.2, 0.1, 0.75], 4.0, 0.5, 58e3),
  p('Poly(vinyl acetate)', 'PVAc', 'dipolar', [-1.0, 0.0, 1.6, 1.8, 0.0, 0.8], 2.5, 0.45, 36e3),
  p('Poly(vinyl chloride-co-vinyl acetate)', 'PVC-VA', 'dipolar', [-1.1, 0.1, 1.3, 1.0, 0.3, 0.85], 3.0, 0.6, 47e3),
  p('Poly(vinylidene fluoride)', 'PVDF', 'dipolar', [-1.3, -0.3, 1.4, 1.5, 0.2, 0.65], 3.2, 0.7, 52e3),
  p('Ethyl cellulose', 'EC', 'dipolar', [-0.95, 0.1, 1.2, 1.9, 0.6, 0.85], 2.2, 0.55, 39e3),
  p('Cellulose acetate', 'CA', 'dipolar', [-1.3, 0.1, 1.7, 2.1, 0.5, 0.7], 3.0, 0.5, 63e3),
  p('Poly(caprolactone)', 'PCL', 'basic', [-0.85, 0.1, 1.3, 1.6, 0.1, 0.85], 1.6, 0.45, 26e3),
  p('Poly(ethylene oxide)', 'PEO', 'basic', [-0.9, 0.2, 1.6, 2.6, 0.3, 0.75], 1.2, 0.4, 31e3),
  p('Poly(ethylene glycol) 20M', 'PEG', 'basic', [-0.6, 0.3, 1.5, 2.5, 0.2, 0.7], 1.0, 0.5, 23e3),
  p('Poly(N-vinylpyrrolidone)', 'PVP', 'basic', [-1.4, 0.3, 1.9, 3.5, 0.0, 0.7], 3.5, 0.45, 71e3),
  p('Polyethyleneimine', 'PEI', 'basic', [-1.58, 0.5, 1.45, 4.28, 0.0, 0.77], 2.0, 0.5, 44e3),
  p('Poly(ethylene maleate)', 'PEM', 'basic', [-1.1, -0.13, 2.1, 3.0, 0.5, 0.7], 2.4, 0.6, 50e3),
  p('Poly(4-vinylphenol)', 'P4VP', 'acidic', [-1.6, 0.4, 1.3, 2.2, 2.4, 0.75], 3.6, 0.5, 68e3),
  p('Poly(styrene-co-allyl alcohol)', 'PSAA', 'acidic', [-1.2, 0.4, 1.1, 1.5, 1.5, 0.85], 3.0, 0.55, 57e3),
  p('Fluoropolyol', 'FPOL', 'acidic', [-1.35, -0.67, 1.48, 1.47, 3.9, 0.82], 1.4, 0.45, 34e3),
  p('Fluorinated siloxane acid', 'SXFA', 'acidic', [-0.85, -0.42, 0.6, 0.71, 3.6, 0.8], 0.9, 0.5, 29e3),
  p('Poly(methyl vinyl ether-co-maleic acid)', 'PMVE-MA', 'acidic', [-1.4, 0.2, 1.4, 1.8, 2.8, 0.7], 2.8, 0.6, 62e3),
  p('Poly(vinyl alcohol)', 'PVA', 'hydrophilic', [-1.8, 0.3, 1.5, 3.0, 2.0, 0.55], 2.6, 0.5, 80e3),
  p('Poly(acrylic acid)', 'PAA', 'hydrophilic', [-1.7, 0.2, 1.6, 2.4, 2.6, 0.6], 2.8, 0.55, 77e3),
];

export const FAMILY_COLORS: Record<PolymerFamily, string> = {
  nonpolar: '#4cc9f0',
  aromatic: '#a78bfa',
  dipolar: '#f9c74f',
  basic: '#f8961e',
  acidic: '#f94144',
  hydrophilic: '#43aa8b',
};
