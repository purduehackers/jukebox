import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PlayerController } from '../app/src/player/controller.ts';
import type { Snapshot } from '../src/contract/types.ts';
import { harness, URLS } from './helpers.ts';
import { ManualTransitionClock } from './manual-transition-clock.ts';
import type { TransitionOptions } from '../app/src/player/volume-transition.ts';

// Exercise the actual controller + service with deterministic native-media events.
// Firefox integration separately verifies real decoding and browser permissions.
class Audio extends EventTarget {
  paused = true;
  ended = false;
  readyState = 4;
  duration = 3600;
  src = '';
  volume = 1;
  error = null;
  allowed = true;
  holdMetadata = false;
  loads = 0;
  plays = 0;
  private position = 0;
  get currentTime() { return this.position; }
  set currentTime(value: number) { this.position = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
  load() {
    this.loads++; this.position = 0; this.ended = false;
    if (this.src && !this.holdMetadata) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
  }
  async play() {
    this.plays++;
    if (!this.allowed) throw new DOMException('Autoplay blocked', 'NotAllowedError');
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  }
  pause() {
    const changed = !this.paused; this.paused = true;
    if (changed) this.dispatchEvent(new Event('pause'));
  }
  removeAttribute() { this.src = ''; }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'controller did not settle');
}

async function setup(t: TestContext, transition: TransitionOptions = { timing: { fadeMs: 0, silenceMs: 0 } }) {
  const h = harness();
  const audio = new Audio();
  const globals = ['window', 'document', 'AudioContext', 'fetch'] as const;
  const before = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new EventTarget(), doc = new EventTarget();
  class Context {
    state = 'running'; onstatechange: (() => void) | null = null; destination = {};
    createAnalyser() { return { fftSize: 2048, connect() {} }; }
    createMediaElementSource() { return { connect() {} }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  const subscribers = new Set<() => void>();
  const push = () => { for (const send of subscribers) send(); };
  const unsubscribe = h.svc.onChange(push);
  let snapshot: Snapshot | null = null;
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get('authorization')?.slice(7);
    const deviceId = bearer ? h.svc.authenticateDevice(bearer) : null;
    const actor = deviceId ? { kind: 'device' as const, deviceId } : h.admin;
    if (String(url).endsWith('/commands')) {
      const response = await h.svc.execute(actor, JSON.parse(String(init!.body)));
      return Response.json(response);
    }
    if (String(url).endsWith('/snapshot')) return Response.json(h.snap(actor));
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      const send = () => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(h.snap(actor))}\n\n`));
      subscribers.add(send); send();
      init?.signal?.addEventListener('abort', () => { subscribers.delete(send); controller.close(); }, { once: true });
    } });
    return new Response(body);
  };
  for (const [key, value] of Object.entries({ window: win, document: doc, AudioContext: Context, fetch: fakeFetch })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const player = new PlayerController(audio as unknown as HTMLAudioElement, () => {}, (s) => { snapshot = s; }, () => {}, transition);
  t.after(async () => {
    player.dispose(); await delay(10); unsubscribe(); h.svc.close();
    for (const key of globals) { const descriptor = before.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  await until(() => player.state.connection === 'connected' && snapshot !== null);
  const start = async (url: string = URLS.mix) => {
    await h.ok(h.admin, 'master.add', { url });
    await h.svc.reconcile();
    await h.ok(h.admin, 'night.open', {});
  };
  return { h, audio, player, start, snapshot: () => snapshot!, push, doc };
}

test('one feed stops sound before presenting the closed night and restarts without reconnecting', async (t) => {
  const x = await setup(t);
  assert.equal(x.audio.plays, 0);
  const generation = x.player.state.generation;
  await x.start(); await until(() => !x.audio.paused);
  for (let i = 0; i < 5; i++) {
    await x.h.ok(x.h.admin, 'night.close', {});
    assert.equal(x.snapshot().night!.status, 'closed');
    assert.equal(x.audio.paused, true);
    await x.h.ok(x.h.admin, 'night.open', {});
    await until(() => !x.audio.paused);
    assert.equal(x.player.state.generation, generation);
  }
});

test('ending a night cancels a pending media load; it cannot start late or fail the track', async (t) => {
  const x = await setup(t);
  x.audio.holdMetadata = true;
  await x.start(); await until(() => x.audio.loads > 0);
  await x.h.ok(x.h.admin, 'night.close', {});
  x.audio.dispatchEvent(new Event('loadedmetadata'));
  await delay(30);
  assert.equal(x.audio.paused, true);
  assert.equal(x.audio.plays, 0);
  assert.equal(x.h.snap().master![0]!.status, 'ready');
  assert.equal(x.h.svc.events(0).filter((e) => e.type === 'player.error').length, 0);
  x.audio.holdMetadata = false;
  await x.h.ok(x.h.admin, 'night.open', {});
  await until(() => !x.audio.paused);
});

test('a pause while loading cannot be overwritten by the older play intent', async (t) => {
  const x = await setup(t);
  x.audio.holdMetadata = true;
  await x.start(); await until(() => x.audio.loads > 0);
  await x.h.ok(x.h.admin, 'playback.pause', {});
  x.audio.holdMetadata = false;
  x.audio.dispatchEvent(new Event('loadedmetadata'));
  await until(() => x.h.snap().playback.confirmation === 'confirmed');
  assert.equal(x.audio.paused, true);
  assert.equal(x.audio.plays, 0);
});

test('native autoplay denial does not fail media; permission recovery and volume do not reload it', async (t) => {
  const x = await setup(t);
  x.audio.allowed = false;
  await x.start(); await until(() => x.player.state.status === 'needs_activation');
  assert.ok(x.audio.plays > 0, 'native play is attempted without an activation flag');
  assert.equal(x.h.svc.events(0).filter((e) => e.type === 'player.error').length, 0);
  const loads = x.audio.loads;
  x.audio.allowed = true;
  x.doc.dispatchEvent(new Event('pointerdown'));
  await until(() => x.player.state.status === 'playing');
  x.audio.currentTime = 123;
  await x.h.ok(x.h.admin, 'playback.volume', { volume: .25 });
  await until(() => x.audio.volume === .25);
  assert.equal(x.audio.loads, loads);
  assert.equal(x.audio.currentTime, 123);
});

test('seek superseding a request load preserves the interrupted master checkpoint', async (t) => {
  const x = await setup(t);
  await x.start(); await until(() => x.player.state.status === 'playing');
  x.audio.currentTime = 123;
  const request = await x.h.ok(x.h.alice, 'request.submit', { url: URLS.r1 });
  await x.h.svc.reconcile();
  const loads = x.audio.loads;
  x.audio.holdMetadata = true;
  await x.h.ok(x.h.admin, 'request.playNow', { entryId: request.entryId });
  await until(() => x.audio.loads > loads);
  await x.h.ok(x.h.admin, 'playback.seek', { entryId: request.entryId, positionSec: 30 });
  x.audio.holdMetadata = false;
  await delay(20);
  x.audio.dispatchEvent(new Event('loadedmetadata'));
  await until(() => x.player.state.status === 'playing' && x.audio.currentTime === 30);
  await until(() => x.h.snap().playback.confirmation === 'confirmed');
  assert.equal(x.h.snap().suspendedMaster!.positionSec, 123);
  assert.equal(x.h.svc.events(0).filter((e) => e.type === 'player.error').length, 0);
});


test('master/request boundaries fade 7s, stay silent 3s and restore the actual paused checkpoint', async (t) => {
  const clock = new ManualTransitionClock();
  const x = await setup(t, { clock });
  await x.start(); await until(() => x.player.state.status === 'playing');
  x.audio.currentTime = 100;
  const originalLoads = x.audio.loads;
  const request = await x.h.ok(x.h.alice, 'request.submit', { url: URLS.r1 });
  await x.h.svc.reconcile();
  await x.h.ok(x.h.admin, 'request.playNow', { entryId: request.entryId });
  await clock.advance(3500);
  assert.ok(Math.abs(x.audio.volume - .4) < .001);
  assert.equal(x.audio.loads, originalLoads, 'master continues on the same audio element during its fade');
  await x.h.ok(x.h.admin, 'playback.volume', { volume: .5 });
  assert.ok(Math.abs(x.audio.volume - .25) < .001, 'volume changes preserve fade progress');
  x.audio.currentTime = 107;
  await clock.advance(3500);
  await until(() => x.audio.loads > originalLoads);
  assert.equal(x.audio.paused, true); assert.equal(x.audio.volume, 0);
  await clock.advance(2999); assert.equal(x.audio.paused, true);
  await clock.advance(1); await until(() => x.player.state.status === 'playing' && !x.audio.paused);
  assert.equal(x.audio.volume, .5, 'request starts directly at the selected volume');
  await until(() => x.h.snap().suspendedMaster?.positionSec === 107);
  const requestLoads = x.audio.loads;
  x.audio.paused = true; x.audio.ended = true;
  x.audio.dispatchEvent(new Event('ended'));
  await until(() => x.audio.loads > requestLoads);
  assert.equal(x.audio.paused, true); assert.equal(x.audio.volume, 0);
  await clock.advance(2999); assert.equal(x.audio.paused, true);
  await clock.advance(1); await until(() => !x.audio.paused);
  assert.equal(x.audio.currentTime, 107);
  assert.equal(x.audio.volume, 0, 'resumed master starts silent');
  await clock.advance(3500); assert.ok(Math.abs(x.audio.volume - .25) < .001);
  await clock.advance(3500); assert.equal(x.audio.volume, .5);
  assert.equal(x.audio.loads, requestLoads + 1, 'fade-in does not reload or seek the master');
  assert.equal(x.h.svc.events(0).filter(e => e.type === 'player.error').length, 0);
});

test('pause and End night cancel a transition without delayed playback or technical failures', async (t) => {
  const clock = new ManualTransitionClock();
  const x = await setup(t, { clock });
  await x.start(); await until(() => x.player.state.status === 'playing');
  const request = await x.h.ok(x.h.alice, 'request.submit', { url: URLS.r1 });
  await x.h.svc.reconcile();
  await x.h.ok(x.h.admin, 'request.playNow', { entryId: request.entryId });
  await clock.advance(2000);
  await x.h.ok(x.h.admin, 'playback.pause', {});
  await until(() => x.h.snap().playback.confirmation === 'confirmed');
  assert.equal(x.audio.paused, true);
  const plays = x.audio.plays;
  await clock.advance(20000); assert.equal(x.audio.plays, plays);
  await x.h.ok(x.h.admin, 'playback.play', {});
  await until(() => !x.audio.paused);
  x.audio.paused = true; x.audio.ended = true; x.audio.dispatchEvent(new Event('ended'));
  await until(() => x.h.snap().schedule.phase === 'master' && x.audio.paused);
  await x.h.ok(x.h.admin, 'night.close', {});
  await clock.advance(20000);
  assert.equal(x.audio.paused, true);
  assert.equal(x.h.svc.events(0).filter(e => e.type === 'player.error').length, 0);
});


test('an ordinary song fades its due tail without ending early, and recovers if the request is removed', async (t) => {
  const clock = new ManualTransitionClock();
  const x = await setup(t, { clock });
  x.audio.duration = 200;
  await x.start(URLS.song); await until(() => x.player.state.status === 'playing');
  const request = await x.h.ok(x.h.alice, 'request.submit', { url: URLS.r1 });
  await x.h.svc.reconcile();
  x.audio.currentTime = 196.5;
  await x.h.advance(15 * 60_000);
  await until(() => Math.abs(x.audio.volume - .4) < .001);
  assert.equal(x.audio.paused, false);
  assert.equal(x.h.snap().nowPlaying!.kind, 'master', 'ordinary song is never cut off to begin a fade');
  await x.h.ok(x.h.admin, 'request.remove', { entryId: request.entryId });
  await until(() => x.audio.volume === .8);
  assert.equal(x.audio.paused, false);
});
