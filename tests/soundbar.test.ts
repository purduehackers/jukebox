import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendTechniques, BAYER4, dither, soundbarField, drawSoundbar, defaults, spectrum, envelope } from '../app/src/visual/soundbar.ts';

test('stationary spectrum keeps a tone at its frequency and silence is zero', () => {
  const fft = new Float32Array(1024).fill(-Infinity);
  assert.ok(spectrum(fft, 48000, 2048, defaults).every(v => v === 0));
  fft[Math.round(1000 * 2048 / 48000)] = -12;
  const first = spectrum(fft, 48000, 2048, defaults);
  assert.ok(first.some(v => v > 0));
  assert.deepEqual(spectrum(fft, 48000, 2048, defaults), first, 'no elapsed-time scroll');
  fft.fill(-Infinity); fft[Math.round(200 * 2048 / 48000)] = -12;
  const bass = spectrum(fft, 48000, 2048, defaults);
  assert.ok(bass.indexOf(Math.max(...bass)) < first.indexOf(Math.max(...first)));
});
test('soundbar is mirrored, fades at its edge and silence is black', () => {
  for (let y = 0; y <= 100; y++) {
    assert.equal(soundbarField(.8, y, 100, defaults), soundbarField(.8, 100 - y, 100, defaults));
    assert.equal(soundbarField(0, y, 100, defaults), 0);
  }
  assert.ok(soundbarField(.8, 50, 100, defaults) > soundbarField(.8, 20, 100, defaults));
  const contour = 500 + .8 * defaults.height * 1000 * .48;
  const fringe = soundbarField(.8, contour + 50, 1000, defaults);
  assert.ok(fringe > 0 && fringe < .5, 'sparse pixels extend beyond the measured contour');
  assert.ok(BAYER4.some((_, i) => dither(fringe, i % 4, Math.floor(i / 4))), 'the outer fade survives dithering');
  assert.equal(soundbarField(.8, contour + 101, 1000, defaults), 0);
  assert.ok(soundbarField(.8, contour + 150, 1000, { ...defaults, edgeSoftness: 300 }) > 0, 'larger softness reaches farther');
  assert.equal(soundbarField(0, 500, 1000, defaults), 0);

});
test('ordered dithering follows the dashboard threshold and has no animated pattern', () => {
  for (const [shade, expected] of [[0, 0], [.5, 8], [1, 16]]) {
    let ink = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ink += Number(dither(shade!, x, y));
    assert.equal(ink, expected);
  }
  let output: Uint8ClampedArray = new Uint8ClampedArray();
  const context = { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4) }), putImageData: (image: ImageData) => { output = image.data.slice(); } } as unknown as CanvasRenderingContext2D;
  drawSoundbar(context, [.5, 1, .5], 40, 40, 2, { ...defaults, edgeSoftness: 12 });
  const first = output.slice();
  drawSoundbar(context, [.5, 1, .5], 40, 40, 2, { ...defaults, edgeSoftness: 12 });
  assert.deepEqual(output, first);
  assert.ok(output.some((v, i) => i % 4 === 0 && v === 126));
  drawSoundbar(context, [0, 0, 0], 40, 40, 2, { ...defaults, edgeSoftness: 12 });
  assert.ok(output.every((v, i) => v === (i % 4 === 3 ? 255 : 0)));
});

test('quiet treble remains visible and a high tone is not diluted by its wider band', () => {
  const peak = (hz: number, db: number) => {
    const fft = new Float32Array(2048).fill(-Infinity);
    fft[Math.round(hz * 4096 / 48000)] = db;
    return Math.max(...spectrum(fft, 48000, 4096, defaults));
  };
  assert.ok(peak(8000, -60) > .3, 'quiet hats must survive the display mapping');
  assert.ok(peak(8000, -40) >= peak(200, -40) - .03, 'wide bands must not dilute a tone');
  assert.ok(peak(8000, -95) === 0, 'signals below the floor stay black');
  const fft = new Float32Array(2048).fill(-Infinity);
  fft[Math.round(8000 * 4096 / 48000)] = -60;
  assert.ok(Math.max(...spectrum(fft, 48000, 4096, { ...defaults, tilt: 3 })) > peak(8000, -60));
  assert.ok(Math.max(...spectrum(fft, 48000, 4096, { ...defaults, gain: defaults.gain * 2 })) > peak(8000, -60));
});

test('fractional bands conserve included FFT energy and ignore invalid values', () => {
  const fft = new Float32Array(2048).fill(-Infinity);
  fft[80] = -45; fft[81] = -45; fft[90] = NaN;
  const s = { ...defaults, minHz: 800, maxHz: 1200, bands: 8, gain: 1, tilt: 0, floorDb: -120, rangeDb: 120 };
  const values = spectrum(fft, 48000, 4096, s);
  const power = values.reduce((sum, v) => sum + (v > 0 ? 10 ** ((v * s.rangeDb + s.floorDb) / 10) : 0), 0);
  assert.ok(Math.abs(power - 2 * 10 ** (-45 / 10)) < 1e-10);
  assert.ok(spectrum(fft, 48000, 4096, { ...s, minHz: 1200 }).every(v => v === 0));
});

test('underlying view renders the same scalar field without the Bayer threshold', () => {
  let output: Uint8ClampedArray = new Uint8ClampedArray();
  const context = { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4) }), putImageData: (image: ImageData) => { output = image.data.slice(); } } as unknown as CanvasRenderingContext2D;
  drawSoundbar(context, [.5, .5, .5], 40, 40, 2, { ...defaults, edgeSoftness: 12 }, false);
  const undithered = output.slice();
  assert.ok(output.some((v, i) => i % 4 === 2 && v > 0 && v < 255), 'raw field has continuous shading');
  drawSoundbar(context, [.5, .5, .5], 40, 40, 2, { ...defaults, edgeSoftness: 12 }, true);
  for (let i = 0; i < output.length; i += 4) {
    if (output[i]! > 0) assert.ok(undithered[i]! > 0, 'dither never invents shape outside the field');
  }
  drawSoundbar(context, [0, 0, 0], 40, 40, 2, { ...defaults, edgeSoftness: 12 }, false);
  assert.ok(output.every((v, i) => v === (i % 4 === 3 ? 255 : 0)));
});


test('soundbar keeps the first and last measured heights at the box edges', () => {
  assert.deepEqual(envelope([.6, .8, .4], 0), [.6, .8, .4]);
  let output: Uint8ClampedArray = new Uint8ClampedArray();
  const context = { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w*h*4) }), putImageData: (image: ImageData) => { output = image.data.slice(); } } as unknown as CanvasRenderingContext2D;
  for (const dithered of [false, true]) {
    drawSoundbar(context, [.6, .8, .4], 40, 200, 2, defaults, dithered);
    for (const x of [0, 39]) {
      assert.ok(Array.from({ length: 200 }, (_, y) => output[(y * 40 + x) * 4 + 2]!).some(v => v > 0),
        'audio must reach both side columns without artificial zero endpoints');
    }
  }
});


test('negative field subtracts the smaller soundbar while preserving the outline and silence', () => {
  let pixels = new Uint8ClampedArray();
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: ImageData) => { pixels = image.data.slice(); },
  } as unknown as CanvasRenderingContext2D;
  const render = (negativeSpace: number, amplitude = .8) => {
    drawSoundbar(context, [amplitude, amplitude], 240, 160, 4, { ...defaults, negativeSpace, density: .85 });
    return pixels.slice();
  };
  const base = render(0), cut = render(1);
  let removed = 0;
  for (let y = 0; y < 160; y++) for (let x = 0; x < 240; x++) {
    const i = (y * 240 + x) * 4 + 2;
    assert.ok(cut[i]! <= base[i]!);
    if (cut[i]! < base[i]!) removed++;
    const inset = .8 * defaults.height * 640 * .48 - Math.abs((y + .5) * 4 - 320);
    if (inset <= defaults.pocketRim) assert.equal(cut[i], base[i], 'top/bottom outline is preserved');
  }
  assert.ok(removed > 1000);
  assert.ok(Array.from({ length: 240 }, (_, x) => cut[(80 * 240 + x) * 4 + 2]).every(v => v === 0), 'the inner band is negative across the width');
  assert.deepEqual(render(1), cut, 'no independently changing procedural field');
  assert.ok(render(1, 0).every((v, i) => v === (i % 4 === 3 ? 255 : 0)));
});


test('blend techniques differ while preserving the protected outline, silence and zero mix', () => {
  let pixels = new Uint8ClampedArray();
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: ImageData) => { pixels = image.data.slice(); },
  } as unknown as CanvasRenderingContext2D;
  const render = (blendTechnique: number, blendAmount: number, amplitude = .8) => {
    drawSoundbar(context, [amplitude, amplitude], 200, 120, 4,
      { ...defaults, blendTechnique, blendAmount, density: .85 }, false);
    return pixels.slice();
  };
  const base = render(0, 0);
  const signatures = new Set<string>();
  for (const mode of blendTechniques) {
    const output = render(mode.value, 1);
    signatures.add(Buffer.from(output).toString('base64'));
    assert.deepEqual(render(mode.value, 0), base, 'zero layer mix restores the original waveform');
    for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) {
      const i = (y * 200 + x) * 4 + 2;
      assert.ok(output[i]! <= base[i]!, 'a blend cannot invent light');
      const inset = .8 * defaults.height * 480 * .48 - Math.abs((y + .5) * 4 - 240);
      if (inset <= defaults.pocketRim) assert.equal(output[i], base[i], 'every technique preserves the rim');
    }
    assert.ok(render(mode.value, 1, 0).every((v, i) => v === (i % 4 === 3 ? 255 : 0)));
  }
  assert.equal(signatures.size, blendTechniques.length, 'each option produces a distinct blend');
});


test('near-solid cores saturate before exact dashboard Bayer dithering', () => {
  let pixels = new Uint8ClampedArray();
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: ImageData) => { pixels = image.data.slice(); },
  } as unknown as CanvasRenderingContext2D;
  const render = (coreSolidness: number, density = 1) => {
    drawSoundbar(context, [.4, .4], 40, 80, 2, { ...defaults, negativeSpace: 0, coreSolidness, density });
    return pixels.slice();
  };
  const original = render(0), solid = render(.4);
  const middle = Array.from({ length: 4 }, (_, y) => Array.from({ length: 4 }, (_, x) => ((y + 38) * 40 + x) * 4 + 2)).flat();
  assert.ok(middle.some(i => original[i] === 0), 'near-white without saturation retains a Bayer hole');
  assert.ok(middle.every(i => solid[i] === 255), 'solid cores have no repeating holes');
  const reducedDensity = render(.4, .8);
  assert.ok(middle.some(i => reducedDensity[i] === 0), 'explicitly reduced fill density remains an intentional dither');
});
