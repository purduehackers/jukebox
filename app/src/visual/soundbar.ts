// Stationary spectrum: each x position is a fixed logarithmic frequency band.
// User-approved preset, 2026-11-05; wider outward edge fade requested 2026-11-09.
export const approvedDefaults = {"gain": 2.3, "height": 0.85, "bands": 92, "attack": 12, "release": 125, "minHz": 20, "maxHz": 15500, "softness": 0, "size": 2, "density": 1, "edgeSoftness": 100, "floorDb": -77, "rangeDb": 63, "tilt": 0.5};
export const defaults = {
  ...approvedDefaults, negativeSpace: 1,
  negativeHeight: 0.45, negativeSoftness: 40,
  pocketRim: 24, coreSolidness: 0.4,
  blendTechnique: 0, blendAmount: 1, blendWidth: 48, blendCurve: 1, blendSoftness: 0.15,
};
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
  { key: 'coreSolidness', label: 'Core solidness', min: 0, max: 1, step: 0.01 },
  { key: 'edgeSoftness', label: 'Edge softness', min: 0, max: 300, step: 1, unit: 'px' },
  { key: 'negativeSpace', label: 'Negative depth', min: 0, max: 1, step: 0.01 },
  { key: 'negativeHeight', label: 'Negative height', min: 0.05, max: 0.9, step: 0.01 },
  { key: 'negativeSoftness', label: 'Negative edge softness', min: 0, max: 160, step: 1, unit: 'px' },
  { key: 'pocketRim', label: 'Outline protection', min: 8, max: 100, step: 1, unit: 'px' },
  { key: 'blendAmount', label: 'Layer mix', min: 0, max: 1, step: 0.01 },
  { key: 'blendWidth', label: 'Edge blend distance', min: 8, max: 200, step: 1, unit: 'px' },
  { key: 'blendCurve', label: 'Blend curve', min: 0.25, max: 3, step: 0.05 },
  { key: 'blendSoftness', label: 'Soft-min radius', min: 0.01, max: 0.5, step: 0.01 },
];
export const blendTechniques = [
  { value: 0, label: 'Multiply', description: 'Gradually thins the purple as the negative field fades in.' },
  { value: 1, label: 'Subtract', description: 'Cuts deeper holes with a stronger separation.' },
  { value: 2, label: 'Soft minimum', description: 'Rounds and melts the junction between the layers.' },
  { value: 3, label: 'Feathered dissolve', description: 'Eases the negative field fade for a softer transition.' },
];

function softMinimum(a: number, b: number, radius: number) {
  const h = Math.max(radius - Math.abs(a - b), 0) / radius;
  return Math.min(a, b) - h * h * radius * .25;
}

function blendNegative(shade: number, cut: number, settings: Settings) {
  if (cut <= 0 || shade <= 0) return shade;
  let carved: number;
  switch (settings.blendTechnique) {
    case 1: carved = Math.max(0, shade - cut); break;
    case 2: {
      // Normalize endpoints so no mask leaves the original intact, and a full
      // mask reaches true black even where both scalar fields are equally bright.
      const low = softMinimum(shade, 0, settings.blendSoftness);
      const high = softMinimum(shade, 1, settings.blendSoftness);
      carved = shade * (softMinimum(shade, 1 - cut, settings.blendSoftness) - low) / (high - low);
      break;
    }
    case 3: carved = shade * (1 - smoothstep(0, 1, cut)); break;
    default: carved = shade * (1 - cut);
  }
  return Math.max(0, Math.min(shade, shade + (carved - shade) * settings.blendAmount));
}

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
  if (amplitude <= 0) return 0;
  const radius = amplitude * settings.height * height * 0.48;
  const distance = radius - Math.abs(y - height / 2);
  // Spread the fade across both sides of the measured contour, keeping the
  // solid core while giving sparse Bayer pixels room outside the waveform.
  // Shrink the spread with quiet bands so the halo also disappears into silence.
  const spread = Math.min(settings.edgeSoftness, radius);
  if (!spread) return distance > 0 ? settings.density : 0;
  const t = Math.max(0, Math.min(1, (distance + spread) / (2 * spread)));
  return settings.density * t * t * (3 - 2 * t);
}
function smoothstep(low: number, high: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

const opaqueBlack = new Uint8Array(new Uint32Array([0xff000000]).buffer)[3] === 255 ? 0xff000000 : 0x000000ff;
const imageBuffers = new WeakMap<CanvasRenderingContext2D, ImageData>();

export function drawSoundbar(context: CanvasRenderingContext2D, values: number[], width: number, height: number, cell: number, settings: Settings, dithered = true, monochrome = false) {
  const points = envelope(values, settings.softness);
  let image = imageBuffers.get(context);
  if (!image || image.width !== width || image.height !== height) {
    image = context.createImageData(width, height);
    imageBuffers.set(context, image);
  }
  // Clear old ink in one native operation; restore opaque black on either byte order.
  const pixels = new Uint32Array(image.data.buffer);
  pixels.fill(opaqueBlack);
  // The negative is the same soundbar function, scaled down vertically.
  // No separate noise, warp, time function or independently moving geometry.
  const negativeSettings = { ...settings, height: settings.height * settings.negativeHeight, density: 1, edgeSoftness: settings.negativeSoftness };
  for (let x = 0; x < width; x++) {
    const position = x / Math.max(1, width - 1) * (points.length - 1);
    const left = Math.floor(position), fraction = position - left;
    const amplitude = points[left]! * (1 - fraction) + points[Math.min(left + 1, points.length - 1)]! * fraction;
    const radius = amplitude * settings.height * height * cell * .48;
    // Outside radius + spread the field is exactly zero. The negative mask
    // only removes ink, so it cannot extend that support.
    const extent = radius + Math.min(settings.edgeSoftness, radius);
    const first = Math.max(0, Math.floor(height / 2 - extent / cell - .5));
    const end = Math.min(height, Math.ceil(height / 2 + extent / cell + .5));
    for (let y = first; y < end; y++) {
      let shade = soundbarField(amplitude, (y + .5) * cell, height * cell, settings);
      const inset = radius - Math.abs((y + .5) * cell - height * cell / 2);
      // Keep the live outline while subtracting the smaller mirrored field.
      if (settings.negativeSpace > 0 && inset > settings.pocketRim) {
        const mask = soundbarField(amplitude, (y + .5) * cell, height * cell, negativeSettings);
        const interior = smoothstep(settings.pocketRim, settings.pocketRim + settings.blendWidth, inset) ** settings.blendCurve;
        shade = blendNegative(shade, settings.negativeSpace * interior * mask, settings);
      }
      // Paper's warp field saturates to exactly 1 before Bayer quantization.
      // Our blended masks otherwise leave near-white plateaus below 1, which
      // preserve the zero-rank Bayer hole even at 99.99% brightness. Add a tunable
      // solid plateau to the field; preserve the user's explicit density cap.
      shade = Math.min(settings.density, shade / (1 - settings.coreSolidness * .25));
      const ink = dithered ? Number(dither(shade, x, y)) : shade;
      const index = (y * width + x) * 4;
      image.data[index] = (monochrome ? 255 : 126) * ink;
      image.data[index + 1] = (monochrome ? 255 : 60) * ink;
      image.data[index + 2] = 255 * ink;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}
