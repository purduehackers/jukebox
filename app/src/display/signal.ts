// Measured frequency-band RMS + time-domain gate. No synthetic signal or idle motion:
// noise only reshapes energy that was measured, so silence still draws nothing.
export interface Energy { bass: number; treble: number }
export interface TimedEnergy extends Energy { time: number }
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/**
 * Every visualizer knob. Override on the display URL, e.g.
 * `/display?viz=driftAmount:0.6,bounceGain:8`, or live from the console through
 * `window.jukeboxVisualizer` (same object, read every frame).
 */
export const DEFAULT_TUNING = {
  // Bands (Hz). `bass` + `treble` set band thickness; `highs` drives the bounce.
  bassLowHz: 30, bassHighHz: 250, trebleHighHz: 10_000, highsLowHz: 4_000, highsHighHz: 14_000,
  gain: 12, highsGain: 40,
  // Band envelope follower (seconds).
  attack: 0.06, release: 0.28,
  // Thickness: weights of bass/treble and maximum half-height (fraction of canvas).
  bassWeight: 0.65, trebleWeight: 0.55, height: 0.36,
  // Fraction of each half-thickness that is always exactly mirrored.
  core: 0.8,
  // One material, applied AFTER band and plume geometry are united.
  fillFloor: 0.85, fillTexture: 0.12, fillScale: 0.12, fillMorph: 0.25,
  driftAmount: 0.22, driftSpeed: 0.35, driftScale: 0.9,
  // Plume geometry: dimensions are fractions of canvas height. Negative sweep
  // goes left; positive goes right. Tips morph independently of the highs bounce.
  wispLength: 0.24, wispWidth: 0.045, wispTaper: 1.4,
  wispSweep: 0.22, wispCurl: 0.08, wispSpacing: 0.8, wispSpeed: 0.3,
  edgeSoftness: 0.012,
  // Bounce from highs onsets: gain on (highs − slow average), follower attack and
  // decay (seconds), averaging window (seconds), how far it expands the band
  // (fraction of thickness) and lifts it (fraction of canvas height).
  bounceGain: 6, bounceAttack: 0.015, bounceDecay: 0.22, bounceAverage: 0.45,
  bounceScale: 0.35, bounceLift: 0.03,
  // Debug view: 0 shows the continuous shade field instead of Bayer dots; guides
  // overlays the finished band attachment edges in white.
  dither: 1, guides: 0,
};
export type Tuning = typeof DEFAULT_TUNING;

/** Parse `key:value,key:value`; unknown keys and non-finite numbers are ignored. */
export function parseTuning(query: string | null, base: Tuning = DEFAULT_TUNING): Tuning {
  const tuning = { ...base };
  for (const pair of (query ?? '').split(',')) {
    const [key, raw] = pair.split(':').map((part) => part.trim());
    const value = Number(raw);
    if (key && key in tuning && raw && Number.isFinite(value)) (tuning as Record<string, number>)[key] = value;
  }
  return tuning;
}

export function measure(frequency: Float32Array, waveform: Float32Array, sampleRate: number, fftSize: number, tuning: Tuning = DEFAULT_TUNING): Energy & { highs: number } {
  let square = 0;
  for (const value of waveform) square += value * value;
  if (Math.sqrt(square / waveform.length) < 0.001) return { bass: 0, treble: 0, highs: 0 };
  function band(low: number, high: number, gain: number) {
    let sum = 0;
    for (let i = Math.max(1, Math.ceil(low * fftSize / sampleRate)); i < Math.min(frequency.length, Math.ceil(high * fftSize / sampleRate)); i++) {
      const amplitude = 10 ** (frequency[i]! / 20);
      sum += amplitude * amplitude;
    }
    // Fixed gain; avoid automatic gain control making silence look loud.
    return Math.min(1, Math.sqrt(sum) * gain);
  }
  return {
    bass: band(tuning.bassLowHz, tuning.bassHighHz, tuning.gain),
    treble: band(tuning.bassHighHz, tuning.trebleHighHz, tuning.gain),
    highs: band(tuning.highsLowHz, tuning.highsHighHz, tuning.highsGain),
  };
}

/** One-pole follower with separate rise/fall time constants (seconds). */
export function follow(previous: number, next: number, dt: number, attack: number, release: number) {
  return previous + (next - previous) * (1 - Math.exp(-dt / Math.max(1e-4, next > previous ? attack : release)));
}

export function smooth(previous: number, next: number, dt: number, tuning: Tuning = DEFAULT_TUNING) {
  return follow(previous, next, dt, tuning.attack, tuning.release);
}

/** Highs onset → bounce: fast attack, slow decay, relative to a running average. */
export interface Bounce { average: number; value: number }
export function bounceStep(state: Bounce, highs: number, dt: number, tuning: Tuning = DEFAULT_TUNING): Bounce {
  const onset = Math.min(1, Math.max(0, highs - state.average) * tuning.bounceGain);
  return {
    average: follow(state.average, highs, dt, tuning.bounceAverage, tuning.bounceAverage),
    value: follow(state.value, onset, dt, tuning.bounceAttack, tuning.bounceDecay),
  };
}

// Smooth 2D value noise in [-1, 1]: quintic-interpolated lattice hashes.
function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}
export function noise(x: number, y: number, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, seed: number) {
  return (noise(x, y, seed) * 0.65 + noise(x * 2.3, y * 1.7, seed + 7) * 0.35);
}

export interface Frame {
  /** Seconds of wall time; drives noise evolution. Frozen for reduced motion. */
  time: number;
  /** Absolute history time (s) at the left and right edges, so features scroll with audio. */
  historyStart: number; historyEnd: number;
  bounce: number;
}

// Reuse the large allocations. No persistent smoke image, blur passes, or feedback.
interface Buffers {
  width: number; height: number; image: ImageData; shape: Float32Array;
  top: Float32Array; bottom: Float32Array; level: Float32Array; flow: Float32Array;
}
const buffers = new WeakMap<CanvasRenderingContext2D, Buffers>();
function scratch(context: CanvasRenderingContext2D, width: number, height: number): Buffers {
  let result = buffers.get(context);
  if (!result || result.width !== width || result.height !== height) {
    result = { width, height, image: context.createImageData(width, height),
      shape: new Float32Array(width * height), top: new Float32Array(width),
      bottom: new Float32Array(width), level: new Float32Array(width),
      flow: new Float32Array((Math.ceil(width / 2) + 1) * (Math.ceil(height / 2) + 1)) };
    buffers.set(context, result);
  }
  result.shape.fill(-1e6); result.top.fill(0); result.bottom.fill(0); result.level.fill(0);
  return result;
}

/** Add a tapered flow shape to the same distance field as the band. Root locations
 * are continuous history times, never FFT/sample indices. The root follows the
 * finished band; its bounce displacement decays cubically along the plume. */
function extendShape(out: Buffers, frame: Frame, tuning: Tuning, center: number, expand: number) {
  const { top, bottom, level } = out;
  // Half-resolution geometry only; material and Bayer remain full resolution.
  const width = Math.ceil(out.width / 2) + 1, height = out.height / 2;
  const shape = out.flow;
  shape.fill(-Math.max(1, tuning.edgeSoftness * height) - 1);
  center /= 2;
  if (tuning.wispLength <= 0 || tuning.wispWidth <= 0) return;
  const span = frame.historyEnd - frame.historyStart;
  if (span <= 0) return; // Reduced motion: stationary band only.
  const spacing = Math.max(0.15, tuning.wispSpacing);
  const morph = frame.time * tuning.wispSpeed;
  const feather = Math.max(0.7, tuning.edgeSoftness * height);
  const read = (values: Float32Array, x: number) => {
    const p = Math.max(0, Math.min(out.width - 1, x * 2)), i = Math.floor(p);
    return values[i]! + (values[Math.min(out.width - 1, i + 1)]! - values[i]!) * (p - i);
  };
  for (const side of [-1, 1]) {
    const edges = side < 0 ? top : bottom;
    for (let id = Math.floor(frame.historyStart / spacing); id <= Math.ceil(frame.historyEnd / spacing); id++) {
      const seed = id * 17 + side * 137;
      const at = (id + 0.3 * hash(id, side, 43)) * spacing;
      const rootX = (at - frame.historyStart) / span * (out.width - 1) / 2;
      if (rootX < 0 || rootX >= width) continue;
      const amplitude = read(level, rootX);
      if (amplitude <= 0.003) continue;
      const variation = 0.5 + 0.5 * noise(seed * 0.19, morph * 0.35, 107);
      const radius = height * tuning.wispWidth * Math.sqrt(amplitude) * (0.6 + variation);
      const length = height * tuning.wispLength * Math.sqrt(amplitude) * (0.45 + variation);
      const wind = height * tuning.wispSweep * (0.65 + variation * 0.5);
      const curl = height * tuning.wispCurl;
      const edge = read(edges, rootX) / 2;
      const restEdge = edge / expand;
      const rest = (out.height - 1) / 4;
      const rootBounce = center - rest + side * (edge - restEdge);
      const bend = noise(seed * 0.31, morph, 83);
      // Adaptive steps: broad roots need fewer discs, fine tips need closer ones.
      for (let u = 0; u < 1;) {
        const r = Math.max(0.25, radius * (1 - u) ** Math.max(0.25, tuning.wispTaper));
        const phase = u * Math.PI * 1.5;
        const cx = rootX + wind * u * u + curl * Math.sin(phase + bend) * u * u;
        const cy = rest + side * (restEdge - radius * 0.35 + length * u
          + curl * Math.sin(phase + morph * 0.35 + seed) * u * u * 0.4)
          + rootBounce * (1 - u) ** 3;
        const reach = r + feather;
        const left = Math.max(0, Math.floor(cx - reach)), right = Math.min(width - 1, Math.ceil(cx + reach));
        const low = Math.max(0, Math.floor(cy - reach)), high = Math.min(Math.ceil(height), Math.ceil(cy + reach));
        for (let y = low; y <= high; y++) {
          const dy2 = (y - cy) * (y - cy), row = y * width;
          for (let x = left; x <= right; x++) {
            if (shape[row + x]! >= r) continue;
            const d2 = (x - cx) * (x - cx) + dy2;
            if (d2 > reach * reach) continue;
            const distance = (r * r - d2) / (2 * r);
            if (distance > shape[row + x]!) shape[row + x] = distance;
          }
        }
        u += Math.max(0.006, r * 0.8 / Math.max(1, length + Math.abs(wind) * 2 + curl * 3));
      }
    }
  }
}

/** Order matters: measured envelope → drift/bounce → extend geometry → shade once
 * → Bayer. There is exactly one silhouette and one material, so roots cannot be
 * a differently shaded overlay or detach from the thickness shown on screen. */
export function drawEnvelope(context: CanvasRenderingContext2D, history: Energy[], width: number, height: number,
  frame: Frame = { time: 0, historyStart: 0, historyEnd: 10, bounce: 0 }, tuning: Tuning = DEFAULT_TUNING) {
  const out = scratch(context, width, height);
  const { image, shape, top, bottom, level } = out;
  const center = (height - 1) / 2 - frame.bounce * tuning.bounceLift * height;
  const expand = 1 + frame.bounce * tuning.bounceScale;
  const feather = Math.max(0.7, tuning.edgeSoftness * height);
  for (let x = 0; x < width; x++) {
    const fraction = x / Math.max(1, width - 1), index = fraction * (history.length - 1);
    const a = history[Math.floor(index)] ?? { bass: 0, treble: 0 };
    const b = history[Math.min(history.length - 1, Math.ceil(index))] ?? a;
    const mix = index % 1;
    const bass = a.bass + (b.bass - a.bass) * mix, treble = a.treble + (b.treble - a.treble) * mix;
    const amplitude = Math.min(1, bass * tuning.bassWeight + treble * tuning.trebleWeight);
    level[x] = amplitude;
    if (amplitude <= 0.003) continue;
    const half = amplitude * height * tuning.height * expand;
    const at = (frame.historyStart + (frame.historyEnd - frame.historyStart) * fraction) * tuning.driftScale;
    top[x] = Math.max(half * tuning.core, half * (1 + tuning.driftAmount * fbm(at, frame.time * tuning.driftSpeed, 11)));
    bottom[x] = Math.max(half * tuning.core, half * (1 + tuning.driftAmount * fbm(at, frame.time * tuning.driftSpeed, 23)));
    const low = Math.max(0, Math.floor(center - top[x]! - feather));
    const high = Math.min(height - 1, Math.ceil(center + bottom[x]! + feather));
    for (let y = low; y <= high; y++) shape[y * width + x] = Math.min(y - center + top[x]!, center + bottom[x]! - y);
  }
  extendShape(out, frame, tuning, center, expand);

  // Low-frequency material noise sampled on an 8-cell grid, interpolated once.
  // Geometry stays at full resolution, including thin tips.
  const cell = Math.max(2, tuning.fillScale * height), morph = frame.time * tuning.fillMorph;
  const gridW = Math.ceil(width / 8) + 1;
  let upper = new Float32Array(gridW), lower = new Float32Array(gridW);
  const noiseRow = (row: Float32Array, y: number) => {
    for (let x = 0; x < gridW; x++) row[x] = noise(x * 8 / cell + morph * 0.6, (y - center) / cell - morph, 71);
  };
  noiseRow(upper, 0); noiseRow(lower, 8);
  const data = image.data;
  const packed = new Uint32Array(data.buffer);
  packed.fill(0xff000000);
  for (let y = 0; y < height; y++) {
    if (y > 0 && y % 8 === 0) { const swap = upper; upper = lower; lower = swap; noiseRow(lower, y + 8); }
    const fy = y % 8 / 8;
    for (let x = 0; x < width; x++) {
      let distance = shape[y * width + x]!;
      if (distance < feather) {
        const flowW = Math.ceil(width / 2) + 1, fi = (y >> 1) * flowW + (x >> 1);
        const tx = (x & 1) * 0.5, ty = (y & 1) * 0.5;
        const f0 = out.flow[fi]! * (1 - tx) + out.flow[fi + 1]! * tx;
        const f1 = out.flow[fi + flowW]! * (1 - tx) + out.flow[fi + flowW + 1]! * tx;
        distance = Math.max(distance, 2 * (f0 * (1 - ty) + f1 * ty));
      }
      if (distance <= -feather) continue;
      const gx = x >> 3, fx = x % 8 / 8;
      const n0 = upper[gx]! + (lower[gx]! - upper[gx]!) * fy;
      const n1 = upper[gx + 1]! + (lower[gx + 1]! - upper[gx + 1]!) * fy;
      const texture = tuning.fillTexture * (n0 + (n1 - n0) * fx);
      const k = Math.min(1, Math.max(0, (distance + feather) / (2 * feather)));
      const shade = Math.min(0.98, Math.max(0, tuning.fillFloor + texture)) * k * k * (3 - 2 * k);
      const offset = (y * width + x) * 4;
      if (tuning.dither < 0.5) {
        data[offset] = 126 * shade; data[offset + 1] = 60 * shade; data[offset + 2] = 255 * shade;
      } else if (shade > BAYER4[(y % 4) * 4 + x % 4]! / 16) {
        packed[y * width + x] = 0xffff3c7e;
      }
    }
  }
  if (tuning.guides >= 0.5) {
    for (let x = 0; x < width; x++) for (const y of [center - top[x]!, center + bottom[x]!]) {
      if (level[x]! <= 0.003 || y < 0 || y >= height) continue;
      const i = (Math.round(y) * width + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

/** Resample by time, so slower rendering never stretches the ten-second window. */
export function envelopeWindow(history: TimedEnergy[], now: number, count = 300): Energy[] {
  let cursor = 0;
  return Array.from({ length: count }, (_, index) => {
    const time = now - 10_000 + index / (count - 1) * 10_000;
    while (cursor + 1 < history.length && history[cursor + 1]!.time <= time) cursor++;
    const a = history[cursor];
    if (!a || a.time > time) return { bass: 0, treble: 0 };
    const b = history[cursor + 1] ?? a;
    const fraction = a.time === b.time ? 0 : (time - a.time) / (b.time - a.time);
    return { bass: a.bass + (b.bass - a.bass) * fraction, treble: a.treble + (b.treble - a.treble) * fraction };
  });
}
