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
  assert.deepEqual(measure(frequencies, new Float32Array(fft), rate, fft), { bass: 0, treble: 0 });
  assert.ok(smooth(0, 1, 0.1) > 0.8);
  assert.equal(new Set(BAYER4).size, 16);
});

test('ten-second history uses actual time even at lower rendering rates', async () => {
  const { envelopeWindow } = await import('../app/src/display/signal.ts');
  const samples = envelopeWindow([{ time: 5000, bass: 0.4, treble: 0.1 }, { time: 10000, bass: 0.8, treble: 0.2 }], 10000, 5);
  assert.deepEqual(samples.map((s) => s.bass), [0, 0, 0.4, 0.6000000000000001, 0.8]);
});
