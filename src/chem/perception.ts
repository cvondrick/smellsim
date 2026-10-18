// A simple model of human odor perception, for comparison with the electronic nose.
//
// Olfactory receptors respond to individual odorants above a detection threshold. The odor
// activity value OAV = C / threshold says how many times above threshold a compound is.
// Perceived intensity grows roughly logarithmically with OAV (Fechner/Stevens), and
// continuous exposure causes adaptation (olfactory fatigue) that recovers away from the odor.

import { COMPOUNDS } from './compounds';

export const INTENSITY_LABELS = ['none', 'threshold', 'weak', 'moderate', 'strong', 'very strong'];

/** Perceived intensity on a 0..5 scale from an odor activity value. */
export function intensityFromOav(oav: number): number {
  if (oav <= 1) return 0;
  return Math.min(5, 0.4 + 1.2 * Math.log10(oav));
}

export function intensityLabel(intensity: number): string {
  return INTENSITY_LABELS[Math.min(5, Math.max(0, Math.round(intensity)))];
}

export interface CompoundPercept {
  compoundIndex: number;
  oav: number;
  intensity: number;
}

/** Odor activity values for every compound, sorted by OAV (descending), above-threshold only. */
export function perceiveCompounds(compoundPpm: ArrayLike<number>, limit = 5): CompoundPercept[] {
  const result: CompoundPercept[] = [];
  for (let index = 0; index < COMPOUNDS.length; index++) {
    const threshold = COMPOUNDS[index].ot;
    if (!isFinite(threshold)) continue;
    const oav = compoundPpm[index] / threshold;
    if (oav > 1) result.push({ compoundIndex: index, oav, intensity: intensityFromOav(oav) });
  }
  result.sort((first, second) => second.oav - first.oav);
  return result.slice(0, limit);
}

/**
 * Adaptation state for one observer. Each odor channel (keyed by source id) fatigues with
 * exposure and recovers in clean air.
 */
export class Adaptation {
  private levels = new Map<string, number>();
  private readonly riseTime = 90; // s to adapt
  private readonly recoveryTime = 40; // s to recover

  /** Advances adaptation and returns the adapted intensity. */
  update(key: string, rawIntensity: number, dt: number): number {
    const level = this.levels.get(key) ?? 0;
    const target = rawIntensity / 5;
    const tau = target > level ? this.riseTime : this.recoveryTime;
    const next = level + (target - level) * (1 - Math.exp(-dt / tau));
    this.levels.set(key, next);
    return rawIntensity * (1 - 0.7 * next);
  }

  level(key: string): number {
    return this.levels.get(key) ?? 0;
  }

  reset(): void {
    this.levels.clear();
  }
}
