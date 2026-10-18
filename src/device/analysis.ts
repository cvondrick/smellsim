// Feature extraction and simple pattern recognition for e-nose measurements.

/** 5-point quadratic Savitzky-Golay smoothing of a time series (edges use shorter windows). */
export function savitzkyGolay(series: ArrayLike<number>): Float64Array {
  const n = series.length;
  const out = new Float64Array(n);
  const coefficients = [-3, 12, 17, 12, -3];
  for (let t = 0; t < n; t++) {
    if (t < 2 || t > n - 3) {
      let sum = 0;
      let count = 0;
      for (let o = -1; o <= 1; o++) {
        const index = t + o;
        if (index >= 0 && index < n) {
          sum += series[index];
          count++;
        }
      }
      out[t] = sum / count;
      continue;
    }
    let sum = 0;
    for (let o = -2; o <= 2; o++) sum += coefficients[o + 2] * series[t + o];
    out[t] = sum / 35;
  }
  return out;
}

/**
 * Smellprint: per-sensor relative response of the sample peak over the mean baseline,
 * S_i = (Rmax_i - R0_i) / R0_i, computed on smoothed resistance traces.
 */
export function smellprint(baseline: Float64Array[], sample: Float64Array[]): Float64Array {
  const sensors = baseline[0]?.length ?? sample[0]?.length ?? 0;
  const result = new Float64Array(sensors);
  if (baseline.length === 0 || sample.length === 0) return result;
  for (let i = 0; i < sensors; i++) {
    const baseSeries = savitzkyGolay(baseline.map((row) => row[i]));
    const sampleSeries = savitzkyGolay(sample.map((row) => row[i]));
    let r0 = 0;
    for (const value of baseSeries) r0 += value;
    r0 /= baseSeries.length;
    let rMax = -Infinity;
    for (const value of sampleSeries) rMax = Math.max(rMax, value);
    result[i] = (rMax - r0) / r0;
  }
  return result;
}

export function norm(vector: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

/** Cosine similarity between two smellprints: compares pattern, not magnitude. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const denominator = norm(a) * norm(b);
  return denominator > 0 ? dot / denominator : 0;
}

/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi). Returns eigenvalues descending. */
export function symmetricEigen(matrix: Float64Array, size: number): { values: Float64Array; vectors: Float64Array } {
  const a = Float64Array.from(matrix);
  const vectors = new Float64Array(size * size);
  for (let i = 0; i < size; i++) vectors[i * size + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let offDiagonal = 0;
    for (let p = 0; p < size; p++) for (let q = p + 1; q < size; q++) offDiagonal += a[p * size + q] ** 2;
    if (offDiagonal < 1e-22) break;
    for (let p = 0; p < size; p++) {
      for (let q = p + 1; q < size; q++) {
        const apq = a[p * size + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q * size + q] - a[p * size + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < size; k++) {
          const akp = a[k * size + p];
          const akq = a[k * size + q];
          a[k * size + p] = c * akp - s * akq;
          a[k * size + q] = s * akp + c * akq;
        }
        for (let k = 0; k < size; k++) {
          const apk = a[p * size + k];
          const aqk = a[q * size + k];
          a[p * size + k] = c * apk - s * aqk;
          a[q * size + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < size; k++) {
          const vkp = vectors[k * size + p];
          const vkq = vectors[k * size + q];
          vectors[k * size + p] = c * vkp - s * vkq;
          vectors[k * size + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: size }, (_, i) => i).sort((i, j) => a[j * size + j] - a[i * size + i]);
  const values = new Float64Array(size);
  const sorted = new Float64Array(size * size);
  order.forEach((source, target) => {
    values[target] = a[source * size + source];
    for (let k = 0; k < size; k++) sorted[k * size + target] = vectors[k * size + source];
  });
  return { values, vectors: sorted };
}

export interface PcaResult {
  scores: [number, number][];
  explained: [number, number];
}

/**
 * PCA of smellprints after unit-length normalization (removes concentration, keeps pattern)
 * and per-sensor autoscaling.
 */
export function pca(prints: ArrayLike<number>[]): PcaResult | null {
  const count = prints.length;
  if (count < 2) return null;
  const dims = prints[0].length;
  const rows = prints.map((print) => {
    const length = norm(print) || 1;
    return Float64Array.from({ length: dims }, (_, i) => print[i] / length);
  });
  const mean = new Float64Array(dims);
  for (const row of rows) for (let i = 0; i < dims; i++) mean[i] += row[i] / count;
  const std = new Float64Array(dims);
  for (const row of rows) for (let i = 0; i < dims; i++) std[i] += (row[i] - mean[i]) ** 2 / count;
  for (let i = 0; i < dims; i++) std[i] = Math.sqrt(std[i]) || 1;
  const centered = rows.map((row) => Float64Array.from({ length: dims }, (_, i) => (row[i] - mean[i]) / std[i]));
  const covariance = new Float64Array(dims * dims);
  for (const row of centered) {
    for (let i = 0; i < dims; i++) for (let j = 0; j < dims; j++) covariance[i * dims + j] += (row[i] * row[j]) / (count - 1);
  }
  const { values, vectors } = symmetricEigen(covariance, dims);
  const totalVariance = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const scores = centered.map((row) => {
    let pc1 = 0;
    let pc2 = 0;
    for (let i = 0; i < dims; i++) {
      pc1 += row[i] * vectors[i * dims];
      pc2 += row[i] * vectors[i * dims + 1];
    }
    return [pc1, pc2] as [number, number];
  });
  return { scores, explained: [Math.max(0, values[0]) / totalVariance, Math.max(0, values[1]) / totalVariance] };
}
