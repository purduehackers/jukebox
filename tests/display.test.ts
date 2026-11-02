import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayFixture, fixtureStates } from '../app/src/display/fixtures.ts';
import { displayModel, duration, requestUrl, safeArtwork } from '../app/src/display/model.ts';
import { measure, smooth, BAYER4 } from '../app/src/display/signal.ts';

test('elapsed countdown counts pause and buffering, ignores seeks, and resets only with authority', () => {
  const now = 1_000_000;
  for (const state of ['master', 'paused', 'buffering'] as const) {
    const snapshot = displayFixture(state, now);
    assert.equal(displayModel(snapshot, now).turn, 'in 06:12');
    assert.equal(displayModel(snapshot, now + 12000).turn, 'in 06:00');
    snapshot.playback.observed!.positionSec = 3000;
    assert.equal(displayModel(snapshot, now + 12000).turn, 'in 06:00');
    snapshot.schedule.periodStartedAt = now + 12000;
    assert.equal(displayModel(snapshot, now + 12000).turn, 'in 15:00');
  }
});
test('status, progress, public queue and stale playback remain honest across fixture states', () => {
  const now = 1_000_000;
  for (const state of fixtureStates) assert.ok(displayModel(displayFixture(state, now), now).turn);
  const snapshot = displayFixture('master', now);
  assert.equal(displayModel(snapshot, now + 5000).progress, 1426);
  assert.equal(displayModel(snapshot, now + 16000).status, 'offline');
  assert.equal(displayModel(snapshot, now + 16000).playing, false);
  assert.equal(displayModel(snapshot, now, true).playing, false);
  assert.equal(displayModel(displayFixture('paused', now), now + 5000).progress, 1421);
  assert.equal(displayModel(displayFixture('request', now), now).requests.length, 2);
  assert.equal(displayModel(displayFixture('due_song', now), now).detail, 'After this master song finishes');
  assert.equal(displayModel(displayFixture('due_paused', now), now).detail, 'Waiting for organizer to resume');
  assert.equal(displayModel(displayFixture('closed', now), now).turn, 'Requests closed');
  snapshot.playback.confirmation = 'requested';
  assert.equal(displayModel(snapshot, now).playing, false);
  assert.equal(displayModel(snapshot, now).progress, null);
  assert.equal(displayModel(snapshot, now).status, 'waiting_for_player');
});
test('QR URLs preserve configured reachable origin and reject non-origin inputs', () => {
  assert.equal(requestUrl('https://jukebox.purduehackers.com', 'http://127.0.0.1:5173'), 'https://jukebox.purduehackers.com/queue');
  assert.equal(requestUrl(undefined, 'http://192.168.1.20:5173'), 'http://192.168.1.20:5173/queue');
  for (const bad of ['javascript:alert(1)', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?x=1']) assert.throws(() => requestUrl(bad, 'http://localhost'));
  assert.equal(safeArtwork('javascript:alert(1)'), undefined);
  assert.equal(safeArtwork('https://u:p@example.com/a.jpg'), undefined);
  assert.equal(duration(3600), '60:00');
});
test('measured bands distinguish bass from treble and silence never creates idle motion', () => {
  const fft = 2048, rate = 48000;
  const frequencies = new Float32Array(fft / 2).fill(-Infinity);
  const wave = Float32Array.from({ length: fft }, (_, i) => Math.sin(i * 0.1) * 0.2);
  frequencies[Math.round(100 * fft / rate)] = -15;
  const bass = measure(frequencies, wave, rate, fft);
  assert.ok(bass.bass > 0.1); assert.equal(bass.treble, 0);
  frequencies.fill(-Infinity); frequencies[Math.round(2000 * fft / rate)] = -15;
  const treble = measure(frequencies, wave, rate, fft);
  assert.ok(treble.treble > 0); assert.equal(treble.bass, 0);
  assert.deepEqual(measure(frequencies, new Float32Array(fft), rate, fft), { bass: 0, treble: 0, highs: 0 });
  assert.ok(smooth(0, 1, 0.1) > 0.8);
  assert.equal(new Set(BAYER4).size, 16);
});

test('ten-second history uses actual time even at lower rendering rates', async () => {
  const { envelopeWindow } = await import('../app/src/display/signal.ts');
  const samples = envelopeWindow([{ time: 5000, bass: 0.4, treble: 0.1 }, { time: 10000, bass: 0.8, treble: 0.2 }], 10000, 5);
  assert.deepEqual(samples.map((s) => s.bass), [0, 0, 0.4, 0.6000000000000001, 0.8]);
});

function render(history: { bass: number; treble: number }[], width: number, height: number, frame?: Parameters<typeof import('../app/src/display/signal.ts').drawEnvelope>[4], tuning?: Parameters<typeof import('../app/src/display/signal.ts').drawEnvelope>[5]) {
  return import('../app/src/display/signal.ts').then(({ drawEnvelope }) => {
    let pixels: Uint8ClampedArray = new Uint8ClampedArray(0);
    const context = {
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: (image: { data: Uint8ClampedArray }) => { pixels = image.data; },
    } as unknown as CanvasRenderingContext2D;
    drawEnvelope(context, history, width, height, frame, tuning);
    return (x: number, y: number) => pixels[(y * width + x) * 4] === 126;
  });
}
test('mirrored band has no axis line in silence and an exactly symmetric core shape', async () => {
  const { DEFAULT_TUNING } = await import('../app/src/display/signal.ts');
  const silent = await render([{ bass: 0, treble: 0 }, { bass: 0, treble: 0 }], 64, 40);
  for (let x = 0; x < 64; x++) for (let y = 0; y < 40; y++) assert.equal(silent(x, y), false);
  // Un-dithered shade field: Bayer rows are not mirror images, so compare the shape itself.
  const flat = { ...DEFAULT_TUNING, driftAmount: 0, wispLength: 0, fillTexture: 0, dither: 0 };
  const loud = Array.from({ length: 8 }, () => ({ bass: 0.8, treble: 0.5 }));
  let red: Uint8ClampedArray = new Uint8ClampedArray(0);
  const { drawEnvelope } = await import('../app/src/display/signal.ts');
  drawEnvelope({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: { data: Uint8ClampedArray }) => { red = image.data; },
  } as unknown as CanvasRenderingContext2D, loud, 64, 41, { time: 3, historyStart: 0, historyEnd: 10, bounce: 0 }, flat);
  const at = (x: number, y: number) => red[(y * 64 + x) * 4]!;
  for (let y = 0; y < 41; y++) for (let x = 0; x < 64; x++) assert.ok(Math.abs(at(x, y) - at(x, 40 - y)) <= 1, `row ${y}`);
  assert.ok(at(10, 0) === 0 && at(10, 20) > 0);
  // The axis row is no brighter than its neighbours: no drawn center line.
  assert.ok(at(10, 20) <= at(10, 19) && at(10, 20) <= at(10, 21));
});
test('drift is smooth noise, bounce has fast attack and slow decay, tuning parses safely', async () => {
  const { noise, bounceStep, parseTuning, DEFAULT_TUNING } = await import('../app/src/display/signal.ts');
  for (let x = 0; x < 5; x += 0.01) assert.ok(Math.abs(noise(x, 1.3) - noise(x + 0.01, 1.3)) < 0.05);
  let state = { average: 0, value: 0 };
  state = bounceStep(state, 0.5, 1 / 30);
  assert.ok(state.value > 0.8, `attack ${state.value}`);
  const peak = state.value;
  state = bounceStep(state, 0, 1 / 30);
  assert.ok(state.value < peak && state.value > peak * 0.7, `decay ${state.value}`);
  const tuning = parseTuning('driftAmount:0.9, bounceGain:2,unknown:4,height:abc');
  assert.equal(tuning.driftAmount, 0.9); assert.equal(tuning.bounceGain, 2);
  assert.equal(tuning.height, DEFAULT_TUNING.height); assert.ok(!('unknown' in tuning));
});

test('flow shares the band material through bounce and silence clears all geometry', async () => {
  const { drawEnvelope, DEFAULT_TUNING } = await import('../app/src/display/signal.ts');
  const width = 180, height = 120;
  let pixels = new Uint8ClampedArray(0);
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: { data: Uint8ClampedArray }) => { pixels = image.data.slice(); },
  } as unknown as CanvasRenderingContext2D;
  const tuning = { ...DEFAULT_TUNING, dither: 0, fillTexture: 0 };
  const history = Array.from({ length: 30 }, (_, i) => ({ bass: 0.35 + 0.2 * Math.sin(i / 4), treble: 0.3 }));
  for (const bounce of [0, 0.5, 1]) {
    const frame = { time: 12, historyStart: 2, historyEnd: 12, bounce };
    drawEnvelope(context, history, width, height, frame, { ...tuning, wispLength: 0 });
    const band = pixels;
    drawEnvelope(context, history, width, height, frame, tuning);
    let extended = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      // No second material can brighten the interior or erase the finished band.
      assert.ok(pixels[i]! >= band[i]!);
      if (band[i] === Math.round(126 * tuning.fillFloor)) assert.equal(pixels[i], band[i]);
      if (pixels[i]! > band[i]!) extended++;
    }
    assert.ok(extended > 50, `flow extends bounced geometry at ${bounce}`);
  }
  drawEnvelope(context, [{ bass: 0, treble: 0 }], width, height, { time: 13, historyStart: 3, historyEnd: 13, bounce: 0 }, tuning);
  for (let i = 0; i < pixels.length; i += 4) assert.equal(pixels[i], 0, 'no stale smoke after audio clears');
});
