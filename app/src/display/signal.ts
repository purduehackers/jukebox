// Measured frequency-band RMS + time-domain gate. No synthetic signal or idle motion.
export interface Energy { bass: number; treble: number }
export interface TimedEnergy extends Energy { time: number }
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

export function measure(frequency: Float32Array, waveform: Float32Array, sampleRate: number, fftSize: number): Energy {
  let square = 0;
  for (const value of waveform) square += value * value;
  if (Math.sqrt(square / waveform.length) < 0.001) return { bass: 0, treble: 0 };
  function band(low: number, high: number) {
    let sum = 0;
    for (let i = Math.max(1, Math.ceil(low * fftSize / sampleRate)); i < Math.min(frequency.length, Math.ceil(high * fftSize / sampleRate)); i++) {
      const amplitude = 10 ** (frequency[i]! / 20);
      sum += amplitude * amplitude;
    }
    // Fixed gain; avoid automatic gain control making silence look loud.
    return Math.min(1, Math.sqrt(sum) * 12);
  }
  return { bass: band(30, 250), treble: band(250, 10_000) };
}

export function smooth(previous: number, next: number, dt: number) {
  return previous + (next - previous) * (1 - Math.exp(-dt / (next > previous ? 0.06 : 0.28)));
}

/** Every output pixel is one two-CSS-pixel Bayer cell; black/purple only. */
export function drawEnvelope(context: CanvasRenderingContext2D, history: Energy[], width: number, height: number) {
  const image = context.createImageData(width, height);
  for (let x = 0; x < width; x++) {
    const index = x / Math.max(1, width - 1) * (history.length - 1);
    const a = history[Math.floor(index)] ?? { bass: 0, treble: 0 };
    const b = history[Math.min(history.length - 1, Math.ceil(index))] ?? a;
    const fraction = index % 1;
    const bass = a.bass + (b.bass - a.bass) * fraction;
    const treble = a.treble + (b.treble - a.treble) * fraction;
    const middle = height / 2;
    for (let y = 0; y < height; y++) {
      const top = middle - bass * height * 0.43;
      const bottom = middle + treble * height * 0.43;
      const distance = y < middle ? y - top : bottom - y;
      const energy = y < middle ? bass : treble;
      const shade = energy > 0.003 && distance >= 0 ? Math.max(0, 1 - distance / (height * 0.14)) * 0.95 : 0;
      const line = Math.abs(y - middle) < 0.6 ? 0.55 : 0;
      const on = Math.max(shade, line) + BAYER4[(y % 4) * 4 + x % 4]! / 16 - 0.5 >= 0.5;
      const offset = (y * width + x) * 4;
      image.data[offset] = on ? 126 : 0;
      image.data[offset + 1] = on ? 60 : 0;
      image.data[offset + 2] = on ? 255 : 0;
      image.data[offset + 3] = 255;
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
