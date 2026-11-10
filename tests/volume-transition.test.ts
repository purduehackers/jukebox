import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRANSITION_TIMING, VolumeTransition } from '../app/src/player/volume-transition.ts';
import { ManualTransitionClock } from './manual-transition-clock.ts';

test('production volume envelope fades for seven seconds and preserves a changed base volume', async () => {
  assert.deepEqual(TRANSITION_TIMING, { fadeMs: 7000, silenceMs: 3000 });
  const clock = new ManualTransitionClock(), audio = { volume: .8 }, abort = new AbortController();
  const fade = new VolumeTransition(audio, { clock });
  fade.setVolume(.8);
  const out = fade.fade(0, abort.signal);
  await clock.advance(3500); assert.ok(Math.abs(audio.volume - .4) < .001);
  fade.setVolume(.5); assert.ok(Math.abs(audio.volume - .25) < .001);
  await clock.advance(3500); await out; assert.equal(audio.volume, 0);
  const incoming = fade.fade(1, abort.signal);
  await clock.advance(3500); assert.ok(Math.abs(audio.volume - .25) < .001);
  await clock.advance(3500); await incoming; assert.equal(audio.volume, .5);
});

test('silence counts time spent loading and cancellation stops a pending fade or gap', async () => {
  const clock = new ManualTransitionClock(), audio = { volume: 1 }, abort = new AbortController();
  const fade = new VolumeTransition(audio, { clock });
  await clock.advance(1200);
  let done = false;
  const gap = fade.silenceSince(0, abort.signal).then(() => { done = true; });
  await clock.advance(1799); assert.equal(done, false);
  await clock.advance(1); await gap; assert.equal(done, true);
  const pending = fade.fade(0, abort.signal);
  await clock.advance(1000); abort.abort(); await assert.rejects(pending);
  const volume = audio.volume;
  await clock.advance(10000); assert.equal(audio.volume, volume, 'cancelled ramp cannot change volume later');
  await assert.rejects(fade.silenceSince(clock.now(), abort.signal));
});
