// Quota, moderation, refunds, sessions, idempotency, and concurrent changes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PortError } from '../src/core/ports.ts';
import { MIN, URLS, harness, submit, user } from './helpers.ts';

test('three accepted submissions per PH ID per night; invalid attempts consume none', async () => {
  const h = harness();
  await h.startNight();
  await h.fails('INVALID_SOURCE', h.alice, 'request.submit', { url: 'http://youtu.be/REQreqreq01' });
  await h.fails('SOURCE_UNSUPPORTED', h.alice, 'request.submit', { url: 'https://www.youtube.com/playlist?list=PL123' });
  await h.fails('SOURCE_UNSUPPORTED', h.alice, 'request.submit', { url: URLS.spotify });
  await h.fails('SOURCE_UNAVAILABLE', h.alice, 'request.submit', { url: 'https://youtu.be/NOTinCATALG' });
  h.source.failNext = new PortError('SOURCE_UNAVAILABLE', 'resolver timed out', true);
  const transient = await h.fails('SOURCE_UNAVAILABLE', h.alice, 'request.submit', { url: URLS.r1 });
  assert.equal(!transient.ok && transient.error.retryable, true);
  assert.equal(h.snap(h.alice).quota?.used, 0);
  for (const url of [URLS.r1, URLS.r2, URLS.r3]) assert.ok((await submit(h, h.alice, url)).ok);
  await h.fails('QUOTA_EXCEEDED', h.alice, 'request.submit', { url: URLS.r4 });
  assert.deepEqual(h.snap(h.alice).quota, { used: 3, limit: 3, remaining: 0 });
  assert.equal(h.snap(h.bob).quota?.used, 0, 'per person');
  await h.fails('UNAUTHENTICATED', { kind: 'public' }, 'request.submit', { url: URLS.r4 });
});

test('duplicates of a waiting playable recording are rejected, including via a different link form', async () => {
  const h = harness();
  await h.startNight();
  assert.ok((await submit(h, h.alice, URLS.r1)).ok);
  await h.fails('DUPLICATE_REQUEST', h.bob, 'request.submit', { url: URLS.r1Alt });
  await h.fails('DUPLICATE_REQUEST', h.bob, 'request.submit', { url: URLS.sameRecording });
  assert.equal(h.snap(h.bob).quota?.used, 0);
});

test('preparation failures refund after bounded retries; admin removal and skip do not refund', async () => {
  const h = harness();
  const p = await h.startNight();
  h.media.failures.set('https://www.youtube.com/watch?v=REQreqreq01', true); // transient, retried once
  await submit(h, h.alice, URLS.r1);
  await h.svc.reconcile();
  assert.equal(h.snap(h.alice).requests.find((r) => r.title === 'Request One')?.status, 'ready', 'retry succeeded');
  h.media.failures.set('https://www.youtube.com/watch?v=REQreqreq02', false); // permanent
  await submit(h, h.alice, URLS.r2);
  const failed = h.snap(h.alice).requests.find((r) => r.title === 'Request Two');
  assert.equal(failed?.status, 'failed');
  assert.equal(h.snap(h.alice).quota?.used, 1, 'refunded');
  // Removal: no refund.
  await submit(h, h.alice, URLS.r3);
  const r3 = h.snap(h.admin).requests.find((r) => r.title === 'Request Three')!;
  await h.ok(h.admin, 'request.remove', { entryId: r3.id });
  assert.equal(h.snap(h.alice).quota?.used, 2);
  // Skip of a playing request: no refund, finishes the turn, fresh period, back to master.
  await h.advance(15 * MIN, p);
  const s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Request One');
  await h.ok(h.admin, 'playback.skip', { entryId: s.nowPlaying!.entryId });
  assert.equal(h.snap().schedule.phase, 'master');
  assert.equal(h.snap().schedule.periodStartedAt, h.clock.now());
  assert.equal(h.snap(h.alice).quota?.used, 2);
  assert.equal(h.snap(h.alice).requests.find((r) => r.title === 'Request One')?.status, 'skipped');
});

test('technical playback failure retries once, then refunds and returns to the suspended master', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.alice, URLS.r2);
  await h.advance(15 * MIN, p);
  const suspended = h.snap().suspendedMaster!;
  await p.sync('error', 0);
  assert.equal(h.snap().schedule.phase, 'request', 'one bounded retry');
  await p.sync('error', 0);
  const s = h.snap();
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(p.desired()!.startPositionSec, suspended.positionSec);
  assert.equal(s.schedule.periodStartedAt, h.clock.now(), 'failed turn still finishes and starts a fresh period');
  assert.equal(h.snap(h.alice).quota?.used, 1, 'failure refunded');
  assert.equal(s.requests.find((r) => r.title === 'Request Two')?.status, 'ready', 'no second request chained into the turn');
});

test('night end pauses, closes submissions, archives pending requests, keeps master; new night resets quota', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.alice, URLS.r2);
  await submit(h, h.alice, URLS.r3);
  await h.advance(15 * MIN, p);
  assert.equal(h.snap().schedule.phase, 'request');
  await h.ok(h.admin, 'night.close', {});
  let s = h.snap();
  assert.equal(s.schedule.intent, 'paused');
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.nowPlaying?.title, 'Hour Mix', 'suspended master restored, paused');
  assert.equal(s.night?.status, 'closed');
  assert.equal(s.requests.filter((r) => r.status === 'ready' || r.status === 'preparing').length, 0);
  assert.equal(s.master?.length, 1, 'master library kept');
  await h.fails('NIGHT_CLOSED', h.alice, 'request.submit', { url: URLS.r4 });
  // No midnight reset: quota is per admin-managed night, not per calendar day.
  await h.ok(h.admin, 'night.open', {});
  s = h.snap(h.alice);
  assert.deepEqual(s.quota, { used: 0, limit: 3, remaining: 3 });
  assert.equal(s.schedule.periodStartedAt, h.clock.now(), 'starting a new session starts master music and its period');
});

test('quota spans midnight within one admin-managed night', async () => {
  const h = harness();
  h.clock.t = Date.UTC(2026, 9, 31, 3, 50); // 23:50 America/Indiana/Indianapolis (EDT)
  await h.startNight();
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.alice, URLS.r2);
  await h.advance(30 * MIN);
  await submit(h, h.alice, URLS.r3);
  await h.fails('QUOTA_EXCEEDED', h.alice, 'request.submit', { url: URLS.r4 });
});

test('stable command IDs: retries replay, conflicting reuse is rejected, rejections replay too', async () => {
  const h = harness();
  await h.startNight();
  const commandId = randomUUID();
  const first = await h.cmd(h.alice, 'request.submit', { url: URLS.r1 }, { commandId });
  const retry = await h.cmd(h.alice, 'request.submit', { url: URLS.r1 }, { commandId });
  assert.ok(first.ok && retry.ok);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.result, first.result);
  assert.equal(h.snap(h.alice).quota?.used, 1, 'retry did not enqueue twice');
  const reuse = await h.cmd(h.alice, 'request.submit', { url: URLS.r2 }, { commandId });
  assert.equal(!reuse.ok && reuse.error.code, 'IDEMPOTENCY_MISMATCH');
  const stolen = await h.cmd(h.bob, 'request.submit', { url: URLS.r1 }, { commandId });
  assert.equal(!stolen.ok && stolen.error.code, 'IDEMPOTENCY_MISMATCH', 'another actor cannot read a stored response');
  // Concurrent duplicate deliveries of one command execute once.
  const id2 = randomUUID();
  const [a, b] = await Promise.all([
    h.cmd(h.bob, 'request.submit', { url: URLS.r2 }, { commandId: id2 }),
    h.cmd(h.bob, 'request.submit', { url: URLS.r2 }, { commandId: id2 }),
  ]);
  assert.ok(a.ok && b.ok);
  assert.equal([a.replayed, b.replayed].filter(Boolean).length, 1);
  assert.equal(h.snap(h.bob).quota?.used, 1);
  // A deterministic rejection replays rather than re-evaluating later.
  const id3 = randomUUID();
  const dup = await h.cmd(h.bob, 'request.submit', { url: URLS.r1 }, { commandId: id3 });
  assert.equal(!dup.ok && dup.error.code, 'DUPLICATE_REQUEST');
  const entry = h.snap().requests.find((r) => r.title === 'Request One')!;
  await h.ok(h.admin, 'request.remove', { entryId: entry.id });
  const dupRetry = await h.cmd(h.bob, 'request.submit', { url: URLS.r1 }, { commandId: id3 });
  assert.equal(dupRetry.replayed, true);
  assert.equal(!dupRetry.ok && dupRetry.error.code, 'DUPLICATE_REQUEST');
});

test('simultaneous submissions at the quota boundary admit exactly one', async () => {
  const h = harness();
  await h.startNight();
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.alice, URLS.r2);
  const results = await Promise.all([URLS.r3, URLS.r4].map((url) => h.cmd(h.alice, 'request.submit', { url })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.error.code === 'QUOTA_EXCEEDED').length, 1);
  // Two people racing for the same recording: one wins, one gets a duplicate rejection.
  const carol = user('carol');
  const dave = user('dave');
  h.source.add('https://youtu.be/RACErace001', { title: 'Race', durationSec: 100 });
  const race = await Promise.all([carol, dave].map((who) => h.cmd(who, 'request.submit', { url: 'https://youtu.be/RACErace001' })));
  assert.equal(race.filter((r) => r.ok).length, 1);
  assert.equal(race.filter((r) => !r.ok && r.error.code === 'DUPLICATE_REQUEST').length, 1);
});

test('simultaneous admin actions: guarded skip applies once; reorder and CAS revisions', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix, URLS.mix2]);
  const current = h.snap().nowPlaying!.entryId;
  const [a, b] = await Promise.all([
    h.cmd(h.admin, 'playback.skip', { entryId: current }),
    h.cmd(h.admin2, 'playback.skip', { entryId: current }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, 'second skip does not skip the next item');
  assert.equal([a, b].filter((r) => !r.ok && r.error.code === 'GUARD_MISMATCH').length, 1);
  assert.equal(h.snap().nowPlaying?.title, 'Second Mix');
  await p.sync('playing', 0);
  // FIFO by default; admins reorder relative to entries, unaffected by concurrent inserts.
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  const [r1, r2] = h.snap().requests;
  await Promise.all([
    h.ok(h.admin, 'request.move', { entryId: r2!.id, afterEntryId: null }),
    submit(h, user('carol'), URLS.r3),
  ]);
  assert.deepEqual(h.snap().requests.map((r) => r.title), ['Request Two', 'Request One', 'Request Three']);
  void r1;
  // Strict CAS for clients that opt in.
  const revision = h.snap().revision;
  await h.ok(h.admin, 'playback.volume', { volume: 0.5 });
  const stale = await h.cmd(h.admin2, 'playback.volume', { volume: 0.9 }, { expectedRevision: revision });
  assert.equal(!stale.ok && stale.error.code, 'REVISION_CONFLICT');
  assert.equal(h.snap().playback.volume, 0.5);
  // Removing an entry twice: second is a clear NOT_FOUND, not a silent second effect.
  const target = h.snap().requests[0]!.id;
  const both = await Promise.all([h.cmd(h.admin, 'request.remove', { entryId: target }), h.cmd(h.admin2, 'request.remove', { entryId: target })]);
  assert.equal(both.filter((r) => r.ok).length, 1);
});

test('role enforcement is server-side', async () => {
  const h = harness();
  await h.fails('FORBIDDEN', h.alice, 'night.open', {});
  await h.fails('UNAUTHENTICATED', { kind: 'public' }, 'playback.play', {});
  const p = await h.startNight();
  await h.fails('FORBIDDEN', p.actor, 'playback.skip', { entryId: randomUUID() });
  await h.fails('FORBIDDEN', h.alice, 'player.claim', {});
  await h.fails('FORBIDDEN', h.admin, 'player.report', { generation: 1, epoch: 1, loadId: 1, status: 'playing', positionSec: 0 });
  await h.fails('BAD_REQUEST', h.admin, 'playback.volume', { volume: 2 });
  await h.fails('BAD_REQUEST', h.admin, 'playback.volume', { volume: 0.5, extra: true });
  const pub = h.snap({ kind: 'public' });
  assert.equal(pub.master, undefined);
  assert.equal(pub.desired, undefined);
  assert.equal(pub.devices, undefined);
  await submit(h, h.alice, URLS.r1);
  assert.equal(h.snap({ kind: 'public' }).requests[0]!.requester, undefined, 'requester identity hidden publicly');
  assert.equal(h.snap(h.bob).requests[0]!.mine, undefined);
  assert.equal(h.snap(h.alice).requests[0]!.mine, true);
  assert.equal(h.snap(h.admin).requests[0]!.requester, 'alice');
});
