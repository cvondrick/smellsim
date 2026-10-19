// Canvas charts for the sensor panel.

import type { PhaseKind } from '../device/cyranose';

/** Display info for one sensor channel. */
export interface ChannelLabel {
  label: string;
  color: string;
  active: boolean;
}

export const PHASE_COLORS: Record<string, string> = {
  baseline: '#ffd166',
  sample: '#4cf2ff',
  idle: '#7d8590',
  purge: '#b48cff',
  live: '#4cf2ff',
};

export function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ratio = Math.min(window.devicePixelRatio, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d')!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

function formatSigned(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 0.01) return value.toFixed(3);
  return value.toExponential(1);
}

/** Diverging color: blue (negative) - dark (zero) - orange/yellow (positive), t in [-1, 1]. */
function diverging(t: number): string {
  const clamped = Math.max(-1, Math.min(1, t));
  if (clamped >= 0) {
    const r = 30 + 225 * Math.min(1, clamped * 1.4);
    const g = 30 + 200 * Math.max(0, clamped - 0.3) / 0.7;
    const b = 40 + 40 * clamped;
    return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
  }
  const s = -clamped;
  return `rgb(${(30 + 20 * s) | 0}, ${(30 + 120 * s) | 0}, ${(40 + 215 * Math.min(1, s * 1.4)) | 0})`;
}

/** Sequential color for normalized raw resistances. */
function sequential(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const r = 20 + 235 * Math.pow(x, 1.2);
  const g = 20 + 200 * Math.pow(x, 0.9) * (1 - 0.3 * x);
  const b = 60 + 140 * Math.sin(Math.PI * Math.min(1, x * 0.9));
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

export interface HeatmapData {
  rows: Float64Array[]; // T rows of 32 resistances
  phases: PhaseKind[];
  baselineMean: Float64Array | null; // per-sensor baseline mean, for dR/R0
}

/**
 * The raw signal as a 32 x T image: one row per sensor, one column per timestep.
 * 'relative' shows (R - R0) / R0 with R0 the baseline mean; 'raw' shows each sensor's
 * resistance min-max normalized over the window (absolute ohms differ ~5x between sensors).
 */
export function drawHeatmap(canvas: HTMLCanvasElement, data: HeatmapData, mode: 'relative' | 'raw', channels: ChannelLabel[]): { scale: number } {
  const context = prepareCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const left = 46;
  const top = 12;
  const bottom = 18;
  const right = 8;
  const rows = data.rows;
  const sensors = channels.length;
  context.font = '9px ui-monospace, monospace';
  context.fillStyle = '#8b95a3';
  if (rows.length === 0) {
    context.fillText('Run a measurement to record the 32 x T signal', left, height / 2);
    return { scale: 0 };
  }
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const cellW = plotW / rows.length;
  const cellH = plotH / sensors;
  let scale = 0;
  const baseline = data.baselineMean ?? rows[0];
  if (mode === 'relative') {
    // color scale from active channels only, so non-sensing spikes do not wash out the image
    for (const row of rows) for (let i = 0; i < sensors; i++) if (channels[i].active) scale = Math.max(scale, Math.abs((row[i] - baseline[i]) / baseline[i]));
    scale = Math.max(scale, 5e-5);
  }
  const minimum = new Float64Array(sensors).fill(Infinity);
  const maximum = new Float64Array(sensors).fill(-Infinity);
  if (mode === 'raw') {
    for (const row of rows) {
      for (let i = 0; i < sensors; i++) {
        minimum[i] = Math.min(minimum[i], row[i]);
        maximum[i] = Math.max(maximum[i], row[i]);
      }
    }
  }
  rows.forEach((row, t) => {
    for (let i = 0; i < sensors; i++) {
      if (mode === 'relative') {
        const value = (row[i] - baseline[i]) / baseline[i];
        context.fillStyle = diverging(Math.sign(value) * Math.sqrt(Math.abs(value) / scale));
      } else {
        const range = maximum[i] - minimum[i] || 1;
        context.fillStyle = sequential((row[i] - minimum[i]) / range);
      }
      context.fillRect(left + t * cellW, top + i * cellH, Math.ceil(cellW), Math.ceil(cellH));
    }
  });
  // phase strip
  rows.forEach((_, t) => {
    context.fillStyle = PHASE_COLORS[data.phases[t]] ?? '#555';
    context.fillRect(left + t * cellW, top - 6, Math.ceil(cellW), 4);
  });
  // sensor labels, every 4th, colored by polymer family
  for (let i = 0; i < sensors; i += 1) {
    if (cellH < 7 && i % 4 !== 0) continue;
    context.fillStyle = channels[i].color;
    context.fillText(channels[i].label, 2, top + (i + 0.8) * cellH);
  }
  context.fillStyle = '#8b95a3';
  context.fillText(`T = ${rows.length} timesteps`, left, height - 4);
  context.fillText(mode === 'relative' ? `color: dR/R0, max ${formatSigned(scale)}` : 'color: per-sensor min..max', left + plotW / 2 - 20, height - 4);
  return { scale };
}

/** Live strip chart of all 32 sensors. */
export function drawTraces(
  canvas: HTMLCanvasElement,
  times: number[],
  values: Float64Array[],
  phases: string[],
  channels: ChannelLabel[],
): void {
  const context = prepareCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const left = 46;
  const right = 8;
  const top = 10;
  const bottom = 16;
  context.font = '9px ui-monospace, monospace';
  if (times.length < 2) {
    context.fillStyle = '#8b95a3';
    context.fillText('waiting for sensor data...', left, height / 2);
    return;
  }
  const t1 = times[times.length - 1];
  const t0 = Math.max(times[0], t1 - 90);
  let low = -1e-5;
  let high = 1e-5;
  values.forEach((row, index) => {
    if (times[index] < t0) return;
    for (let i = 0; i < row.length; i++) {
      if (!channels[i]?.active) continue;
      low = Math.min(low, row[i]);
      high = Math.max(high, row[i]);
    }
  });
  const pad = (high - low) * 0.08;
  low -= pad;
  high += pad;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const x = (t: number) => left + ((t - t0) / Math.max(1e-6, t1 - t0)) * plotW;
  const y = (v: number) => top + (1 - (v - low) / (high - low)) * plotH;
  // phase background
  for (let index = 1; index < times.length; index++) {
    if (times[index] < t0) continue;
    context.fillStyle = (PHASE_COLORS[phases[index]] ?? '#333') + '22';
    context.fillRect(x(times[index - 1]), top, Math.max(1, x(times[index]) - x(times[index - 1])), plotH);
  }
  context.strokeStyle = '#3a4250';
  context.beginPath();
  context.moveTo(left, y(0));
  context.lineTo(left + plotW, y(0));
  context.stroke();
  for (let i = 0; i < channels.length; i++) {
    if (!channels[i].active) continue;
    context.strokeStyle = channels[i].color;
    context.globalAlpha = 0.8;
    context.lineWidth = 1;
    context.beginPath();
    let started = false;
    for (let index = 0; index < times.length; index++) {
      if (times[index] < t0) continue;
      const px = x(times[index]);
      const py = y(values[index][i]);
      if (!started) {
        context.moveTo(px, py);
        started = true;
      } else context.lineTo(px, py);
    }
    context.stroke();
  }
  context.globalAlpha = 1;
  context.fillStyle = '#8b95a3';
  context.fillText(formatSigned(high), 2, top + 8);
  context.fillText(formatSigned(low), 2, top + plotH);
  context.fillText('dR/R vs reference', 2, top + plotH / 2);
  context.fillText(`${Math.round(t1 - t0)} s`, width - 30, height - 4);
}

/** 32-bar smellprint, colored by polymer family. */
export function drawSmellprint(canvas: HTMLCanvasElement, print: Float64Array | null, channels: ChannelLabel[]): void {
  const context = prepareCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const left = 46;
  const right = 8;
  const top = 8;
  const bottom = 30;
  context.font = '9px ui-monospace, monospace';
  if (!print) {
    context.fillStyle = '#8b95a3';
    context.fillText('no measurement yet', left, height / 2);
    return;
  }
  let maxAbs = 1e-6;
  print.forEach((value, i) => {
    if (channels[i]?.active) maxAbs = Math.max(maxAbs, Math.abs(value));
  });
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const zero = top + plotH / 2;
  const barW = plotW / print.length;
  context.strokeStyle = '#3a4250';
  context.beginPath();
  context.moveTo(left, zero);
  context.lineTo(left + plotW, zero);
  context.stroke();
  print.forEach((value, i) => {
    // non-sensing channels are clipped to the scale of the active ones
    const clipped = Math.max(-maxAbs, Math.min(maxAbs, value));
    const h = (clipped / maxAbs) * (plotH / 2);
    context.fillStyle = channels[i].active ? channels[i].color : '#5b657366';
    context.fillRect(left + i * barW + 1, Math.min(zero, zero - h), Math.max(1, barW - 2), Math.abs(h));
  });
  context.save();
  context.translate(0, 0);
  for (let i = 0; i < print.length; i++) {
    context.save();
    context.translate(left + (i + 0.5) * barW + 3, height - bottom + 4);
    context.rotate(Math.PI / 2.4);
    context.fillStyle = channels[i].color;
    context.fillText(channels[i].label, 0, 0);
    context.restore();
  }
  context.restore();
  context.fillStyle = '#8b95a3';
  context.fillText(formatSigned(maxAbs), 2, top + 8);
  context.fillText(formatSigned(-maxAbs), 2, top + plotH);
}

export interface ScatterPoint {
  x: number;
  y: number;
  color: string;
  label: string;
  highlight: boolean;
}

export function drawScatter(canvas: HTMLCanvasElement, points: ScatterPoint[], axes: [string, string]): void {
  const context = prepareCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const pad = 18;
  context.font = '9px ui-monospace, monospace';
  if (points.length < 2) {
    context.fillStyle = '#8b95a3';
    context.fillText('capture 2+ measurements to see the smell space', pad, height / 2);
    return;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const x = (v: number) => pad + ((v - minX) / spanX) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - minY) / spanY) * (height - 2 * pad);
  context.strokeStyle = '#2c3340';
  context.strokeRect(pad, pad, width - 2 * pad, height - 2 * pad);
  const labeled = new Set<string>();
  for (const point of points) {
    context.fillStyle = point.color;
    context.beginPath();
    context.arc(x(point.x), y(point.y), point.highlight ? 6 : 4, 0, Math.PI * 2);
    context.fill();
    if (point.highlight) {
      context.strokeStyle = '#ffffff';
      context.lineWidth = 2;
      context.stroke();
      context.lineWidth = 1;
    }
    if (!labeled.has(point.label) || point.highlight) {
      labeled.add(point.label);
      const text = point.label.slice(0, 18);
      const textWidth = context.measureText(text).width;
      const px = x(point.x);
      const left = px + 6 + textWidth > width - 2 ? px - 6 - textWidth : px + 6;
      context.fillStyle = '#c9d1d9';
      context.fillText(text, left, y(point.y) - 4);
    }
  }
  context.fillStyle = '#8b95a3';
  context.fillText(axes[0], width / 2 - 20, height - 4);
  context.save();
  context.translate(10, height / 2 + 20);
  context.rotate(-Math.PI / 2);
  context.fillText(axes[1], 0, 0);
  context.restore();
}
