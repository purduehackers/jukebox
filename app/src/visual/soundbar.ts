// Stationary spectrum: each x position is a fixed logarithmic frequency band.
// Exact user-approved preset, 2026-11-05; archived in docs/jukebox/references/.
export const approvedDefaults = {"gain": 2.3, "height": 0.85, "bands": 92, "attack": 12, "release": 125, "minHz": 20, "maxHz": 15500, "softness": 0, "size": 2, "density": 1, "edgeSoftness": 100, "floorDb": -77, "rangeDb": 63, "tilt": 0.5};
export const defaults = { ...approvedDefaults };
export type Settings = typeof defaults;
export const controls: { key: keyof Settings; label: string; min: number; max: number; step: number; unit?: string }[] = [
  { key: 'gain', label: 'Sensitivity', min: 0.1, max: 12, step: 0.1 },
  { key: 'floorDb', label: 'Display floor', min: -110, max: -40, step: 1, unit: 'dB' },
  { key: 'rangeDb', label: 'Display range', min: 30, max: 100, step: 1, unit: 'dB' },
  { key: 'tilt', label: 'Treble weighting', min: -3, max: 6, step: 0.25, unit: 'dB/oct' },
  { key: 'height', label: 'Height', min: 0.1, max: 1, step: 0.01 },
  { key: 'bands', label: 'Frequency bands', min: 8, max: 128, step: 1 },
  { key: 'attack', label: 'Attack', min: 0, max: 300, step: 1, unit: 'ms' },
  { key: 'release', label: 'Release', min: 0, max: 1000, step: 5, unit: 'ms' },
  { key: 'minHz', label: 'Lowest frequency', min: 20, max: 500, step: 10, unit: 'Hz' },
  { key: 'maxHz', label: 'Highest frequency', min: 1000, max: 20000, step: 100, unit: 'Hz' },
  { key: 'softness', label: 'Contour smoothing', min: 0, max: 8, step: 1 },
  { key: 'size', label: 'Dither pixel size', min: 0.5, max: 8, step: 0.5 },
  { key: 'density', label: 'Fill density', min: 0.05, max: 1, step: 0.01 },
  { key: 'edgeSoftness', label: 'Edge softness', min: 0, max: 100, step: 1, unit: 'px' },
];
export function spectrum(fft: Float32Array, sampleRate: number, fftSize: number, settings: Settings): number[] {
  const low = Math.min(settings.minHz, sampleRate / 2), high = Math.min(settings.maxHz, sampleRate / 2);
  if (high <= low) return Array(settings.bands).fill(0);
  const binHz = sampleRate / fftSize;
  return Array.from({ length: settings.bands }, (_, i) => {
    const fromHz = low * (high / low) ** (i / settings.bands);
    const toHz = low * (high / low) ** ((i + 1) / settings.bands);
    const from = fromHz / binHz, to = toHz / binHz;
    let power = 0;
    // Integrate energy, rather than averaging it away in wider treble bands.
    // Fractional bin overlap avoids counting the whole boundary bin twice.
    for (let bin = Math.max(1, Math.floor(from + .5)); bin < Math.min(fft.length, Math.ceil(to + .5)); bin++) {
      const overlap = Math.max(0, Math.min(to, bin + .5) - Math.max(from, bin - .5));
      if (Number.isFinite(fft[bin])) power += 10 ** (fft[bin]! / 10) * overlap;
    }
    if (power <= 0) return 0;
    const db = 10 * Math.log10(power) + 20 * Math.log10(settings.gain)
      + settings.tilt * Math.log2(Math.sqrt(fromHz * toHz) / 1000);
    return Math.max(0, Math.min(1, (db - settings.floorDb) / settings.rangeDb));
  });
}
// The dashboard's Paper Design shader separates its scalar `shape` function
// from this ordered-dither operation. Reuse only that operation, not its warp.
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export function dither(shape: number, x: number, y: number): boolean {
  // GLSL: dithering = getBayerValue(pixel, 4) - .5;
  //       res = step(.5, shape + dithering);
  return shape + BAYER4[(y % 4) * 4 + x % 4]! / 16 - 0.5 >= 0.5;
}
export function envelope(values: number[], radius: number): number[] {
  // Preserve measured endpoint heights: the box clips the contour at its sides.
  return values.map((_, i) => {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) { sum += values[j]!; count++; }
    return sum / count;
  });
}
// One grayscale soundbar function; evaluated first, then passed to dither().
export function soundbarField(amplitude: number, y: number, height: number, settings: Settings): number {
  const distance = amplitude * settings.height * height * 0.48 - Math.abs(y - height / 2);
  if (distance <= 0) return 0;
  const t = settings.edgeSoftness ? Math.min(1, distance / settings.edgeSoftness) : 1;
  return settings.density * t * t * (3 - 2 * t);
}
export function drawSoundbar(context: CanvasRenderingContext2D, values: number[], width: number, height: number, cell: number, settings: Settings, dithered = true) {
  const points = envelope(values, settings.softness);
  const image = context.createImageData(width, height);
  for (let x = 0; x < width; x++) {
    const position = x / Math.max(1, width - 1) * (points.length - 1);
    const left = Math.floor(position), fraction = position - left;
    const amplitude = points[left]! * (1 - fraction) + points[Math.min(left + 1, points.length - 1)]! * fraction;
    for (let y = 0; y < height; y++) {
      const shade = soundbarField(amplitude, (y + .5) * cell, height * cell, settings);
      const ink = dithered ? Number(dither(shade, x, y)) : shade;
      const index = (y * width + x) * 4;
      image.data[index] = 126 * ink;
      image.data[index + 1] = 60 * ink;
      image.data[index + 2] = 255 * ink;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}
