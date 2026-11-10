// Queue playback controls: mode (auto/master/requests), Play now, and the request interval.
// Deterministic: fake clock, source, media and player. Production policy values throughout.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database as DatabaseSync } from 'bun:sqlite';
import { test } from 'node:test';
import { ValidationError, parseEnvelope } from '../src/contract/validate.ts';
import { FakeClock, FakeMedia, FakeSource } from '../src/adapters/fakes.ts';
import { MIGRATIONS } from '../src/server/db.ts';
import { JukeboxService } from '../src/server/service.ts';
import { MIN, URLS, harness, player, submit } from './helpers.ts';
import type { Harness, Player } from './helpers.ts';

const idOf = (h: Harness, title: string) => h.snap().requests.find((r) => r.title === title)!.id;
const status = (h: Harness, title: string) => h.snap().requests.find((r) => r.title === title)?.status;
const setMode = (h: Harness, mode: 'auto' | 'master' | 'requests') => h.ok(h.admin, 'queue.mode', { mode });
const setInterval_ = (h: Harness, periodMs: number | null) => h.ok(h.admin, 'queue.interval', { periodMs });

/** Report the heartbeat of the already-loaded (now stale) load, as a player does while holding silence. */
const staleReport = (p: Player, loadId: number, epoch: number, positionSec: number) =>
  p.report({ generation: p.generation, epoch, loadId, status: 'paused', positionSec });

/** Time passing while the player is silent: it keeps heartbeating the held load, so its lease stays live. */
async function idleFor(h: Harness, p: Player, ms: number, load: number, epoch: number, positionSec: number) {
  for (let left = ms; left > 0; left -= 5000) {
    h.clock.advance(Math.min(5000, left));
    assert.ok((await staleReport(p, load, epoch, positionSec)).ok);
    await h.svc.reconcile();
  }
}

// ------------------------------------------------------------------ contract

test('commands are admin-only and validated; defaults match the existing policy', async () => {
  const h = harness();
  await h.startNight([URLS.mix]);
  const s = h.snap();
  assert.equal(s.schedule.mode, 'auto');
  assert.equal(s.schedule.periodMs, 15 * MIN);
  assert.equal(s.schedule.periodDefaultMs, 15 * MIN);
  assert.equal(s.schedule.requestsIdle, false);
  await h.fails('FORBIDDEN', h.alice, 'queue.mode', { mode: 'requests' });
  await h.fails('FORBIDDEN', h.alice, 'queue.interval', { periodMs: 5 * MIN });
  await h.fails('FORBIDDEN', h.alice, 'request.playNow', { entryId: randomUUID() });
  await h.fails('UNAUTHENTICATED', { kind: 'public' }, 'queue.mode', { mode: 'master' });
  await h.fails('BAD_REQUEST', h.admin, 'queue.mode', { mode: 'shuffle' });
  await h.fails('BAD_REQUEST', h.admin, 'queue.mode', {});
  await h.fails('BAD_REQUEST', h.admin, 'queue.interval', { periodMs: '5' });
  await h.fails('BAD_REQUEST', h.admin, 'queue.interval', {});
  await h.fails('BAD_REQUEST', h.admin, 'queue.interval', { periodMs: 30_000 }); // below the 1 minute floor
  await h.fails('BAD_REQUEST', h.admin, 'queue.interval', { periodMs: 121 * MIN });
  await h.fails('BAD_REQUEST', h.admin, 'queue.interval', { periodMs: 5 * MIN, extra: true });
  assert.equal(h.snap().schedule.periodMs, 15 * MIN, 'rejected commands change nothing');
});

test('link bound is 2048 characters on exactly master.add, request.preview and request.submit', () => {
  const url = (n: number) => `https://youtu.be/${'a'.repeat(n - 'https://youtu.be/'.length)}`;
  for (const type of ['master.add', 'request.preview', 'request.submit'] as const) {
    const make = (n: number) => ({ commandId: randomUUID(), type, payload: { url: url(n) } });
    assert.equal(parseEnvelope(make(300)).type, type);
    assert.equal(parseEnvelope(make(301)).type, type, `${type}: 301 chars is now allowed`);
    assert.equal(parseEnvelope(make(2048)).type, type);
    assert.throws(() => parseEnvelope(make(2049)), ValidationError, `${type}: 2049 chars rejected`);
  }
  // Nothing else widened.
  const env = (type: string, payload: unknown) => ({ commandId: randomUUID(), type, payload });
  assert.throws(() => parseEnvelope(env('device.pairing.create', { name: 'x'.repeat(61) })), ValidationError);
  assert.throws(() => parseEnvelope(env('device.pair', { code: 'x'.repeat(21) })), ValidationError);
  assert.throws(() => parseEnvelope(env('request.submit', { url: url(100), expectRecordingKey: 'k'.repeat(201) })), ValidationError);
  assert.throws(() => parseEnvelope(env('master.add', { url: '' })), ValidationError);
});

// ------------------------------------------------------------------ Play now

test('Play now cuts in over a mix immediately, resumes at the actual paused position, then a fresh period; allowance untouched', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  await h.advance(3 * MIN, p);
  await p.sync('playing', 181.5);
  const masterLoad = p.desired()!.loadId;
  const used = h.snap(h.alice).quota!.used;
  await h.ok(h.admin, 'request.playNow', { entryId: idOf(h, 'Request Two') }); // out of queue order, on purpose
  let s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Request Two');
  assert.equal(s.schedule.phase, 'request');
  assert.equal(s.suspendedMaster?.positionSec, 181.5);
  await p.sync('playing', 0, { loadId: masterLoad, positionSec: 183.25 });
  assert.equal(h.snap().suspendedMaster?.positionSec, 183.25, 'actual paused position replaces the heartbeat');
  assert.equal(h.snap(h.alice).quota!.used, used, 'no allowance change');
  await h.advance(200_000, p);
  await p.sync('ended', 200);
  s = h.snap();
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(p.desired()!.startPositionSec, 183.25);
  assert.equal(s.schedule.periodStartedAt, h.clock.now(), 'fresh interval after the turn');
  assert.equal(status(h, 'Request One'), 'ready', 'the other request keeps waiting');
  // One request per automatic turn afterwards.
  await h.advance(15 * MIN - 1, p);
  assert.equal(h.snap().schedule.phase, 'master');
  await h.advance(1, p);
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
});

test('Play now interrupts an ordinary song too (explicit action) and resumes that song where it left off', async () => {
  const h = harness();
  const p = await h.startNight([URLS.song, URLS.boundary]);
  await submit(h, h.alice, URLS.r1);
  await h.advance(MIN, p);
  await p.sync('playing', 100);
  const load = p.desired()!.loadId;
  await h.ok(h.admin, 'request.playNow', { entryId: idOf(h, 'Request One') });
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
  assert.equal(h.snap().suspendedMaster?.title, 'Master Song');
  await p.sync('playing', 0, { loadId: load, positionSec: 101 });
  await p.sync('ended', 180);
  const s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Master Song', 'same song, not the next one');
  assert.equal(p.desired()!.startPositionSec, 101);
});

test('Play now guards: loading, already playing, gone, closed night', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  h.media.autoReady = false;
  await submit(h, h.alice, URLS.r1);
  await h.fails('NOT_READY', h.admin, 'request.playNow', { entryId: idOf(h, 'Request One') });
  h.media.autoReady = true;
  await submit(h, h.bob, URLS.r2);
  await h.fails('NOT_FOUND', h.admin, 'request.playNow', { entryId: randomUUID() });
  await h.ok(h.admin, 'request.playNow', { entryId: idOf(h, 'Request Two') });
  // Another request is already playing: never cut it off.
  h.media.autoReady = true;
  await submit(h, h.alice, URLS.r3);
  await h.fails('GUARD_MISMATCH', h.admin, 'request.playNow', { entryId: idOf(h, 'Request Three') });
  assert.equal(h.snap().nowPlaying?.title, 'Request Two');
  await h.ok(h.admin, 'request.remove', { entryId: idOf(h, 'Request Three') });
  await h.fails('NOT_FOUND', h.admin, 'request.playNow', { entryId: idOf(h, 'Request Three') });
  await p.sync('ended', 200);
  await h.ok(h.admin, 'night.close', {});
  await h.fails('NIGHT_CLOSED', h.admin, 'request.playNow', { entryId: idOf(h, 'Request One') });
});

test('deliberate pause stays a pause through Play now and every mode change', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  await h.ok(h.admin, 'playback.pause', {});
  await p.sync('paused', 60);
  await h.ok(h.admin, 'request.playNow', { entryId: idOf(h, 'Request One') });
  assert.equal(h.snap().schedule.intent, 'paused');
  assert.equal(p.desired()!.intent, 'paused', 'request loads but does not start');
  await p.sync('paused', 0);
  await h.ok(h.admin, 'playback.play', {});
  assert.equal(p.desired()!.intent, 'playing');
  await h.ok(h.admin, 'playback.pause', {});
  await setMode(h, 'requests');
  assert.equal(h.snap().schedule.intent, 'paused');
  await p.sync('ended', 180); // request ends while paused: next request loads, still paused
  assert.equal(h.snap().nowPlaying?.title, 'Request Two');
  assert.equal(p.desired()!.intent, 'paused');
  await setMode(h, 'master');
  assert.equal(h.snap().schedule.intent, 'paused');
  await setMode(h, 'auto');
  assert.equal(h.snap().schedule.intent, 'paused');
});

// ------------------------------------------------------------------ Master only

test('Master only: no automatic turns however long; Play now still works; back to Auto starts a fresh interval', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await setMode(h, 'master');
  assert.equal(h.snap().schedule.periodStartedAt, null);
  const epoch = p.desired()!.epoch;
  await h.advance(45 * MIN, p);
  let s = h.snap();
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.schedule.turnDue, false);
  assert.equal(s.schedule.dueReason, null);
  assert.equal(p.desired()!.epoch, epoch, 'audio never touched');
  assert.equal(status(h, 'Request One'), 'ready');
  // Back to Auto: a fresh interval, not an immediate catch-up turn.
  await setMode(h, 'auto');
  s = h.snap();
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.schedule.periodStartedAt, h.clock.now());
  await h.advance(15 * MIN - 1, p);
  assert.equal(h.snap().schedule.phase, 'master');
  await h.advance(1, p);
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
  await p.sync('ended', 180);
  // One-off in master mode: plays, then master resumes with no timer.
  await submit(h, h.bob, URLS.r2);
  await setMode(h, 'master');
  await h.ok(h.admin, 'request.playNow', { entryId: idOf(h, 'Request Two') });
  await p.sync('ended', 200);
  s = h.snap();
  assert.equal(s.schedule.mode, 'master');
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(s.schedule.periodStartedAt, null);
});

test('Master only: an ordinary song ending moves to the next master item, never a request', async () => {
  const h = harness();
  const p = await h.startNight([URLS.song, URLS.boundary]);
  await submit(h, h.alice, URLS.r1);
  await setMode(h, 'master');
  await h.advance(40 * MIN, p);
  await p.sync('ended', 200);
  assert.equal(h.snap().nowPlaying?.title, 'Exactly Six');
  assert.equal(status(h, 'Request One'), 'ready');
});

// ------------------------------------------------------------------ Requests only

test('Requests only with ready requests: cuts in now, plays back to back, then waits silently; new request starts at once', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  await h.advance(2 * MIN, p);
  await p.sync('playing', 120);
  const masterLoad = p.desired()!.loadId;
  const epochBeforeCut = p.desired()!.epoch;
  await setMode(h, 'requests');
  let s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Request One', 'immediate, FIFO');
  assert.equal(s.schedule.periodStartedAt, null);
  assert.equal(s.suspendedMaster?.title, 'Hour Mix');
  await p.sync('playing', 0, { loadId: masterLoad, positionSec: 121 });
  await p.sync('ended', 180);
  assert.equal(h.snap().nowPlaying?.title, 'Request Two', 'back to back, no 15 minute gap');
  assert.equal(h.snap().schedule.mode, 'requests');
  await p.sync('ended', 200);
  s = h.snap();
  assert.equal(s.schedule.requestsIdle, true);
  assert.equal(s.nowPlaying, null);
  assert.equal(s.schedule.turnDue, false);
  assert.equal(p.desired(), null, 'silent');
  assert.equal(s.suspendedMaster?.positionSec, 121, 'master stays suspended');
  // The suspended master asset stays pinned while idle.
  await h.svc.reconcile();
  const masterAsset = JSON.parse((h.svc.db.prepare('select asset from master_items').get() as { asset: string }).asset).assetId;
  assert.ok(h.svc.retentionSet().includes(masterAsset));
  assert.ok(h.media.retained.assetIds.includes(masterAsset));
  await idleFor(h, p, 60 * MIN, masterLoad, epochBeforeCut, 121);
  assert.equal(h.snap().schedule.requestsIdle, true, 'stays idle however long');
  await submit(h, h.alice, URLS.r3);
  assert.equal(h.snap().nowPlaying?.title, 'Request Three', 'starts as soon as it is ready');
  await p.sync('ended', 150);
  assert.equal(h.snap().schedule.requestsIdle, true);
  await setMode(h, 'auto');
  s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(p.desired()!.startPositionSec, 121);
  assert.equal(s.schedule.periodStartedAt, h.clock.now());
  assert.equal(s.schedule.requestsIdle, false);
});

test('Requests only with ZERO ready requests: master checkpoint tracks the actual paused position through idle', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await h.advance(5 * MIN, p);
  await p.sync('playing', 300); // last heartbeat before the cut
  const load = p.desired()!.loadId;
  const epoch = p.desired()!.epoch;
  await setMode(h, 'requests');
  let s = h.snap();
  assert.equal(s.schedule.requestsIdle, true);
  assert.equal(p.desired(), null);
  assert.equal(s.suspendedMaster?.positionSec, 300, 'server only knows the last heartbeat at the moment of the cut');
  // The player paused 3.7 s later than its last heartbeat; its report of the held load carries the actual position.
  assert.ok((await staleReport(p, load, epoch, 303.7)).ok);
  assert.equal(h.snap().suspendedMaster?.positionSec, 303.7);
  await idleFor(h, p, 10 * MIN, load, epoch, 303.7); // idle heartbeats keep the lease
  assert.equal(h.snap().suspendedMaster?.positionSec, 303.7);
  // Master only: resumes exactly at the paused position with no interval running.
  await setMode(h, 'master');
  s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(p.desired()!.startPositionSec, 303.7, 'zero resume error against the reported paused time');
  assert.equal(s.schedule.periodStartedAt, null);
  assert.equal(s.suspendedMaster, null);
  // And Auto from idle: same exactness, and a fresh interval.
  await p.sync('playing', 303.7);
  const load2 = p.desired()!.loadId;
  const epoch2 = p.desired()!.epoch;
  await setMode(h, 'requests');
  assert.equal(p.desired(), null);
  assert.ok((await staleReport(p, load2, epoch2, 310.1)).ok);
  await setMode(h, 'auto');
  assert.equal(p.desired()!.startPositionSec, 310.1);
  assert.equal(h.snap().schedule.periodStartedAt, h.clock.now());
});

test('Requests only idle survives a service restart and resumes the master at the checkpoint in Auto', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await h.advance(4 * MIN, p);
  await p.sync('playing', 240);
  const load = p.desired()!.loadId;
  const epoch = p.desired()!.epoch;
  await setMode(h, 'requests');
  await staleReport(p, load, epoch, 241.25);
  h.restart();
  const restarted = player(h, p.deviceId);
  restarted.generation = p.generation;
  let s = h.snap();
  assert.equal(s.schedule.mode, 'requests');
  assert.equal(s.schedule.requestsIdle, true);
  assert.equal(s.suspendedMaster?.positionSec, 241.25);
  await submit(h, h.alice, URLS.r1);
  assert.equal(h.snap().nowPlaying?.title, 'Request One', 'idle scheduler starts a ready request after restart');
  await restarted.sync('ended', 180);
  await setMode(h, 'auto');
  s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(restarted.desired()!.startPositionSec, 241.25);
});

test('a playing request is never cut off by a mode change; the new mode applies when it ends', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  await h.advance(15 * MIN, p);
  assert.equal(h.snap().nowPlaying?.title, 'Request One'); // automatic turn
  await setMode(h, 'requests');
  assert.equal(h.snap().nowPlaying?.title, 'Request One', 'not cut off');
  await setMode(h, 'master');
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
  await p.sync('ended', 180);
  let s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Hour Mix', 'master mode: back to master');
  assert.equal(s.schedule.periodStartedAt, null);
  assert.equal(status(h, 'Request Two'), 'ready');
  await h.ok(h.admin, 'request.playNow', { entryId: idOf(h, 'Request Two') });
  await setMode(h, 'auto');
  await p.sync('ended', 200);
  s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(s.schedule.periodStartedAt, h.clock.now(), 'auto: fresh interval');
});

test('technical failures still refund and the requests-only chain continues', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  await setMode(h, 'requests');
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
  await p.sync('error', 0); // first failure: one bounded reload
  await p.sync('error', 0);
  assert.equal(status(h, 'Request One'), 'failed');
  assert.equal(h.snap(h.alice).quota!.used, 0, 'refunded');
  assert.equal(h.snap().nowPlaying?.title, 'Request Two', 'chain continues');
  await h.ok(h.admin, 'request.remove', { entryId: idOf(h, 'Request Two') });
  assert.equal(h.snap(h.bob).quota!.used, 1, 'admin removal is not refunded');
  assert.equal(h.snap().schedule.requestsIdle, true);
});

test('Requests only needs an open night', async () => {
  const h = harness();
  await h.fails('NIGHT_CLOSED', h.admin, 'queue.mode', { mode: 'requests' });
});

// ------------------------------------------------------------------ night boundaries

test('closing a night while Requests only is idle resets the mode, resumes master paused, keeps the interval', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await setInterval_(h, 7 * MIN);
  await h.advance(2 * MIN, p);
  await p.sync('playing', 120);
  const load = p.desired()!.loadId;
  const epoch = p.desired()!.epoch;
  await setMode(h, 'requests');
  await staleReport(p, load, epoch, 122.5);
  h.media.autoReady = false;
  await submit(h, h.alice, URLS.r1); // still preparing: archived, not "the playing request"
  await h.ok(h.admin, 'night.close', {});
  const s = h.snap();
  assert.equal(s.night?.status, 'closed');
  assert.equal(s.schedule.mode, 'auto');
  assert.equal(s.schedule.requestsIdle, false);
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.schedule.intent, 'paused');
  assert.equal(s.schedule.periodStartedAt, null);
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(s.suspendedMaster, null);
  assert.equal(s.schedule.periodMs, 7 * MIN, 'the interval setting persists');
  assert.equal(status(h, 'Request One'), 'archived');
  const events = h.svc.events(0, 1000).map((e) => e.type);
  assert.ok(!events.includes('request.archived'), 'no nonexistent request was archived');
  // Reopen: still Auto, interval kept, music restarts at the master.
  await h.ok(h.admin, 'night.open', {});
  assert.equal(h.snap().schedule.mode, 'auto');
  assert.equal(h.snap().schedule.periodMs, 7 * MIN);
});

test('closing a night while Requests only is playing a request archives it, resets the mode and resumes master paused', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  await h.advance(MIN, p);
  await p.sync('playing', 61);
  await setMode(h, 'requests');
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
  await h.ok(h.admin, 'night.close', {});
  const s = h.snap();
  assert.equal(s.schedule.mode, 'auto');
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(s.schedule.intent, 'paused');
  assert.equal(s.schedule.phase, 'master');
  assert.equal(status(h, 'Request One'), 'archived', 'the playing request is archived, not chained');
  assert.equal(status(h, 'Request Two'), 'archived');
  assert.equal(h.snap(h.alice).quota, undefined, 'closed night: no allowance shown');
});

test('opening a night resets a stale non-auto mode', async () => {
  const h = harness();
  await setMode(h, 'master'); // allowed outside a night
  assert.equal(h.snap().schedule.mode, 'master');
  await h.ok(h.admin, 'night.open', {});
  assert.equal(h.snap().schedule.mode, 'auto');
});

// ------------------------------------------------------------------ interval

test('interval applies to the running countdown; shorter makes a turn due now, longer extends it', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await h.advance(8 * MIN, p);
  const anchor = h.snap().schedule.periodStartedAt;
  await setInterval_(h, 20 * MIN);
  assert.equal(h.snap().schedule.periodMs, 20 * MIN);
  assert.equal(h.snap().schedule.periodStartedAt, anchor, 'anchor untouched');
  await h.advance(11 * MIN + 59_000, p); // 19:59 elapsed
  assert.equal(h.snap().schedule.phase, 'master');
  await h.advance(1000, p);
  assert.equal(h.snap().nowPlaying?.title, 'Request One', 'due at anchor + 20 min');
  await p.sync('ended', 180);
  await submit(h, h.bob, URLS.r2);
  await h.advance(12 * MIN, p);
  await setInterval_(h, 10 * MIN); // already 12 elapsed: due immediately, mix is cut in
  assert.equal(h.snap().nowPlaying?.title, 'Request Two');
  await p.sync('ended', 200);
  assert.equal(h.snap().schedule.periodStartedAt, h.clock.now());
  await setInterval_(h, null);
  assert.equal(h.snap().schedule.periodMs, 15 * MIN, 'null restores the default');
});

test('shortening below elapsed with no ready request is an empty turn: anchor resets, audio untouched; pause stays', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await h.advance(10 * MIN, p);
  const epoch = p.desired()!.epoch;
  await setInterval_(h, 5 * MIN);
  let s = h.snap();
  assert.equal(s.schedule.periodStartedAt, h.clock.now());
  assert.equal(p.desired()!.epoch, epoch);
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  // Even while deliberately paused the empty turn resets the period and leaves the pause alone.
  await h.ok(h.admin, 'playback.pause', {});
  await p.sync('paused', 600);
  await h.advance(6 * MIN, p);
  s = h.snap();
  assert.equal(s.schedule.intent, 'paused');
  assert.equal(s.schedule.periodStartedAt, h.clock.now() - MIN, 'second empty turn re-anchored 5 min after the first');
});

test('shortening below elapsed while paused with a ready request waits for Play', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await h.ok(h.admin, 'playback.pause', {});
  await p.sync('paused', 30);
  await h.advance(10 * MIN, p);
  await setInterval_(h, 5 * MIN);
  const s = h.snap();
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.schedule.turnDue, true);
  assert.equal(s.schedule.dueReason, 'paused');
  await h.ok(h.admin, 'playback.play', {});
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
});

test('interval with an ordinary song: due flagged, the song finishes first', async () => {
  const h = harness();
  const p = await h.startNight([URLS.song, URLS.boundary]);
  await submit(h, h.alice, URLS.r1);
  await h.advance(2 * MIN, p);
  await setInterval_(h, MIN);
  const s = h.snap();
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.schedule.turnDue, true);
  assert.equal(s.schedule.dueReason, 'song_end');
  await p.sync('ended', 200);
  assert.equal(h.snap().nowPlaying?.title, 'Request One');
});

test('interval persists across restart; requests-only/master modes persist too', async () => {
  const h = harness();
  await h.startNight([URLS.mix]);
  await setInterval_(h, 9 * MIN);
  await setMode(h, 'master');
  h.restart();
  const s = h.snap();
  assert.equal(s.schedule.periodMs, 9 * MIN);
  assert.equal(s.schedule.mode, 'master');
});

// ------------------------------------------------------------------ retries and concurrency

test('stable command IDs: replays do not re-execute; a different payload is a mismatch', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  const commandId = randomUUID();
  const first = await h.cmd(h.admin, 'queue.mode', { mode: 'master' }, { commandId });
  const again = await h.cmd(h.admin, 'queue.mode', { mode: 'master' }, { commandId });
  assert.ok(first.ok && again.ok && again.replayed);
  assert.equal(again.ok && again.revision, first.ok && first.revision);
  const mismatch = await h.cmd(h.admin, 'queue.mode', { mode: 'requests' }, { commandId });
  assert.ok(!mismatch.ok && mismatch.error.code === 'IDEMPOTENCY_MISMATCH');
  assert.equal(h.snap().schedule.mode, 'master');

  const playId = randomUUID();
  const entryId = idOf(h, 'Request One');
  const a = await h.cmd(h.admin, 'request.playNow', { entryId }, { commandId: playId });
  const revision = h.svc.revision();
  const b = await h.cmd(h.admin, 'request.playNow', { entryId }, { commandId: playId }); // would be GUARD_MISMATCH if re-executed
  assert.ok(a.ok && b.ok && b.replayed);
  assert.equal(h.svc.revision(), revision, 'replay changed nothing');
  // A deterministic rejection is stored and replays identically.
  const rejected = randomUUID();
  const r1 = await h.cmd(h.admin, 'queue.interval', { periodMs: 10_000 }, { commandId: rejected });
  const r2 = await h.cmd(h.admin, 'queue.interval', { periodMs: 10_000 }, { commandId: rejected });
  assert.ok(!r1.ok && !r2.ok && r2.replayed);
  void p;
});

test('concurrent admins: two Play now commands start exactly one request; racing modes end consistent', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  const results = await Promise.all([
    h.cmd(h.admin, 'request.playNow', { entryId: idOf(h, 'Request One') }),
    h.cmd(h.admin2, 'request.playNow', { entryId: idOf(h, 'Request Two') }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  const loser = results.find((r) => !r.ok);
  assert.ok(loser && !loser.ok && loser.error.code === 'GUARD_MISMATCH');
  assert.equal(h.snap().requests.filter((r) => r.status === 'playing').length, 1);
  await p.sync('ended', 200);
  await Promise.all([
    h.cmd(h.admin, 'queue.mode', { mode: 'requests' }),
    h.cmd(h.admin2, 'queue.mode', { mode: 'master' }),
    h.cmd(h.admin, 'queue.interval', { periodMs: 5 * MIN }),
    h.cmd(h.admin2, 'queue.interval', { periodMs: 6 * MIN }),
  ]);
  let s = h.snap();
  assert.equal(s.schedule.mode, 'master', 'last write wins, deterministically');
  assert.equal(s.schedule.periodMs, 6 * MIN);
  assert.equal(s.schedule.requestsIdle, false);
  // Requests-only won the race first and started the other request; the later Master only never cuts it off.
  assert.equal(s.nowPlaying?.kind, 'request');
  assert.equal(s.suspendedMaster?.title, 'Hour Mix');
  await p.sync('ended', 200);
  s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(s.suspendedMaster, null);
  assert.equal(s.schedule.periodStartedAt, null);
});

// ------------------------------------------------------------------ migration

test('a v3 database upgrades in place to the current schema keeping queue, quota, lease, suspended mix and period anchor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jukebox-v3-'));
  const dbPath = join(dir, 'state.sqlite3');
  const clock = new FakeClock();
  const now = clock.now();
  const raw = new DatabaseSync(dbPath);
  raw.exec('pragma journal_mode = wal');
  for (const migration of MIGRATIONS.slice(0, 3)) raw.exec(migration);
  raw.exec('pragma user_version = 3');
  const asset = (id: string, durationSec: number) => JSON.stringify({ assetId: id, url: `/media/${id}`, mime: 'audio/webm', codec: 'opus', durationSec, byteLength: 1 });
  const mixId = randomUUID(), reqPlaying = randomUUID(), reqWaiting = randomUUID(), reqRefunded = randomUUID();
  raw.prepare("insert into nights values('night-1', 'open', ?, null)").run(now - 20 * MIN);
  raw.prepare(`insert into master_items(id, order_key, source_url, provider, title, artist, duration_sec, recording_key, selection, status, asset, created_at)
    values(?, 1, 'https://youtu.be/MIXmixmix01', 'youtube', 'Hour Mix', null, 3600, 'youtube:MIXmixmix01', 'null', 'ready', ?, ?)`).run(mixId, asset(randomUUID(), 3600), now);
  const insertRequest = raw.prepare(`insert into requests(id, night_id, requester_key, requester_name, order_key, source_url, provider, title, artist, duration_sec, recording_key, selection, status, asset, charged, refunded, created_at)
    values(?, 'night-1', ?, ?, ?, ?, 'youtube', ?, null, 180, ?, 'null', ?, ?, 1, ?, ?)`);
  insertRequest.run(reqPlaying, 'test#alice', 'alice', 1, 'https://youtu.be/REQreqreq01', 'Request One', 'youtube:REQreqreq01', 'playing', asset(randomUUID(), 180), 0, now);
  insertRequest.run(reqWaiting, 'test#alice', 'alice', 2, 'https://youtu.be/REQreqreq02', 'Request Two', 'youtube:REQreqreq02', 'ready', asset(randomUUID(), 200), 0, now);
  insertRequest.run(reqRefunded, 'test#alice', 'alice', 3, 'https://youtu.be/REQreqreq03', 'Request Three', 'youtube:REQreqreq03', 'failed', null, 1, now);
  raw.prepare("insert into devices(id, name, token_hash, paired_at, automatic) values('dev-1', 'Display browser', 'hash', ?, 1)").run(now - 10 * MIN);
  raw.prepare(`update playback set phase = 'request', intent = 'playing', period_started_at = ?, current_id = ?, master_cursor = ?, master_position = 700,
    suspended = ?, epoch = 9, load_id = 4, desired_at = ?, generation = 3, lease_device = 'dev-1', lease_expires = ?, acked_epoch = 9 where id = 1`)
    .run(now - 6 * MIN, reqPlaying, mixId, JSON.stringify({ itemId: mixId, positionSec: 701.5, loadId: 3 }), now, now + 10_000);
  const pauseId = randomUUID();
  const pauseHash = createHash('sha256').update(JSON.stringify(['playback.pause', null, {}])).digest('hex');
  raw.prepare("insert into commands values(?, 'user:test#organizer1', 'playback.pause', ?, ?, ?)")
    .run(pauseId, pauseHash, JSON.stringify({ ok: true, commandId: pauseId, revision: 0, result: {}, replayed: false }), now);
  raw.close();

  const source = new FakeSource();
  const svc = new JukeboxService({ dbPath, clock, source, media: new FakeMedia() });
  try {
    assert.equal((svc.db.prepare('pragma user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
    assert.deepEqual(svc.db.prepare('select username from banned_usernames').all(), []);
    const admin = { kind: 'user' as const, identity: { key: 'test#organizer1', issuer: 'test', subject: 'organizer1', displayName: 'organizer1', roles: ['organizer'] } };
    const alice = { kind: 'user' as const, identity: { key: 'test#alice', issuer: 'test', subject: 'alice', displayName: 'alice', roles: [] as string[] } };
    const s = svc.snapshot(admin);
    assert.equal(s.schedule.mode, 'auto');
    assert.equal(s.schedule.periodMs, 15 * MIN);
    assert.equal(s.schedule.phase, 'request');
    assert.equal(s.nowPlaying?.title, 'Request One');
    assert.equal(s.suspendedMaster?.positionSec, 701.5);
    assert.equal(s.schedule.periodStartedAt, now - 6 * MIN);
    assert.equal(s.requests.filter((r) => r.status === 'ready').length, 1);
    assert.equal(svc.snapshot(alice).quota?.used, 2, 'the refunded request is not counted');
    assert.equal(s.devices?.find((d) => d.id === 'dev-1')?.holdsLease, true);
    assert.equal((svc.db.prepare('select generation from playback').get() as { generation: number }).generation, 3,
      'migration preserves the stored generation');
    assert.equal(svc.snapshot({ kind: 'device', deviceId: 'dev-1' }).lease, null,
      'automatic displays no longer require an exclusive lease');
    // Stored command replays across the upgrade.
    const replay = await svc.execute(admin, { commandId: pauseId, type: 'playback.pause', payload: {} });
    assert.ok(replay.ok && replay.replayed);
    // New controls work on the migrated state: request ends, master resumes at the saved position, fresh interval.
    const device = { kind: 'device' as const, deviceId: 'dev-1' };
    const ended = await svc.execute(device, { commandId: randomUUID(), type: 'player.report',
      payload: { generation: 3, epoch: 9, loadId: 4, status: 'ended', positionSec: 180 } });
    assert.ok(ended.ok, JSON.stringify(ended));
    const after = svc.snapshot(admin);
    assert.equal(after.nowPlaying?.title, 'Hour Mix');
    assert.equal(svc.snapshot(device).desired?.startPositionSec, 701.5);
    assert.equal(after.schedule.periodStartedAt, now);
    const mode = await svc.execute(admin, { commandId: randomUUID(), type: 'queue.mode', payload: { mode: 'requests' } });
    assert.ok(mode.ok);
    assert.equal(svc.snapshot(admin).nowPlaying?.title, 'Request Two');
  } finally {
    svc.close();
  }
});
