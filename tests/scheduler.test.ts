// Deterministic scheduler behavior with a fake clock, source, media, and player.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIN, URLS, harness, submit } from './helpers.ts';

test('mix is interrupted exactly at 15:00 elapsed, one request plays, mix resumes at actual position', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await submit(h, h.bob, URLS.r2);
  await h.advance(15 * MIN - 1, p);
  await p.sync('playing', 899.9);
  assert.equal(h.snap().schedule.phase, 'master', 'not due at 14:59.999');
  const masterLoad = p.desired()!.loadId;
  await h.advance(1);
  let s = h.snap();
  assert.equal(s.schedule.phase, 'request');
  assert.equal(s.nowPlaying?.title, 'Request One', 'FIFO');
  assert.equal(s.suspendedMaster?.positionSec, 899.9, 'last checkpoint before the actual pause report');
  // The player's first report for the request carries the actual paused master position.
  await p.sync('playing', 0, { loadId: masterLoad, positionSec: 900.25 });
  assert.equal(h.snap().suspendedMaster?.positionSec, 900.25);
  await h.advance(180_000, p);
  await p.sync('ended', 180);
  s = h.snap();
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.nowPlaying?.title, 'Hour Mix');
  assert.equal(p.desired()!.startPositionSec, 900.25, 'resume at saved actual position');
  assert.equal(s.schedule.periodStartedAt, h.clock.now(), 'fresh period after the request');
  assert.equal(s.requests.find((r) => r.title === 'Request One')?.status, 'played');
  // Exactly one request per turn: Request Two waits for the next full period.
  await h.advance(15 * MIN - 1, p);
  assert.equal(h.snap().schedule.phase, 'master');
  await h.advance(1, p);
  assert.equal(h.snap().nowPlaying?.title, 'Request Two');
});

test('ordinary master songs (including exactly 360s) finish before a due request; 361s is a mix', async () => {
  const h = harness();
  const p = await h.startNight([URLS.boundary, URLS.song]);
  await submit(h, h.alice, URLS.r1);
  await h.advance(15 * MIN, p);
  let s = h.snap();
  assert.equal(s.schedule.phase, 'master', 'normal song not interrupted');
  assert.equal(s.schedule.turnDue, true);
  assert.equal(s.schedule.dueReason, 'song_end');
  await p.sync('ended', 360);
  s = h.snap();
  assert.equal(s.nowPlaying?.title, 'Request One');
  assert.equal(s.suspendedMaster, null, 'a finished song is not resumed');
  await p.sync('ended', 180);
  assert.equal(h.snap().nowPlaying?.title, 'Master Song', 'continues with the next master item');

  const h2 = harness();
  const p2 = await h2.startNight([URLS.justMix]);
  await submit(h2, h2.alice, URLS.r1);
  await h2.advance(15 * MIN, p2);
  assert.equal(h2.snap().schedule.phase, 'request', '361s master is an interruptible mix');
});

test('request duration is strictly under 360s, by metadata and by prepared asset', async () => {
  const h = harness();
  await h.startNight();
  await h.fails('DURATION_REJECTED', h.alice, 'request.submit', { url: URLS.long });
  assert.equal(h.snap(h.alice).quota?.used, 0, 'rejected submissions use no allowance');
  assert.ok((await submit(h, h.alice, URLS.almost)).ok, '359.999s accepted');
  // Metadata said < 360 but the validated prepared asset is longer: fail and refund.
  h.source.add(URLS.r3, { title: 'Lying Metadata', durationSec: 200 });
  h.media.autoReady = false;
  await submit(h, h.bob, URLS.r3);
  const job = [...h.media.jobs.entries()].find(([, j]) => j.source.title === 'Lying Metadata')!;
  h.media.jobs.get(job[0])!.state = { status: 'ready', asset: { assetId: '00000000-0000-4000-8000-000000000001', url: '/media/x', mime: 'audio/webm', codec: 'opus', durationSec: 360, byteLength: 1 } };
  await h.svc.reconcile();
  const bob = h.snap(h.bob);
  assert.equal(bob.requests.find((r) => r.mine)?.status, 'failed');
  assert.equal(bob.quota?.used, 0, 'technical/validation failure after acceptance is refunded');
});

test('empty turn resets the period: empty 9:15 + submission 9:17 waits until 9:30', async () => {
  const h = harness();
  const nine = h.clock.now();
  const p = await h.startNight([URLS.mix]);
  await h.advance(15 * MIN, p); // 9:15, nothing ready
  let s = h.snap();
  assert.equal(s.schedule.periodStartedAt, nine + 15 * MIN, 'empty turn re-anchors');
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.schedule.intent, 'playing', 'music continues');
  await h.advance(2 * MIN, p); // 9:17
  await submit(h, h.alice, URLS.r1);
  await h.advance(13 * MIN - 1, p);
  assert.equal(h.snap().schedule.phase, 'master', 'not at 9:29:59.999');
  await h.advance(1, p);
  s = h.snap();
  assert.equal(s.schedule.phase, 'request', 'due at 9:30');
});

test('empty turn resets even while deliberately paused, without starting audio', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await h.ok(h.admin, 'playback.pause', {});
  await p.sync('paused', 30);
  const epoch = p.desired()!.epoch;
  await h.advance(15 * MIN, p);
  const s = h.snap();
  assert.equal(s.schedule.periodStartedAt, h.clock.now());
  assert.equal(s.schedule.intent, 'paused');
  assert.equal(p.desired()!.epoch, epoch, 'no desired-playback change');
});

test('due request while paused waits for organizer resume; resume interrupts the mix at the paused position', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await h.advance(5 * MIN, p);
  await h.ok(h.admin, 'playback.pause', {});
  await p.sync('paused', 300);
  await h.ok(h.admin, 'playback.seek', { entryId: h.snap().nowPlaying!.entryId, positionSec: 1234.5 });
  await p.sync('paused', 1234.5);
  await h.advance(10 * MIN, p); // pause counts toward the elapsed period
  let s = h.snap();
  assert.equal(s.schedule.phase, 'master');
  assert.equal(s.schedule.turnDue, true);
  assert.equal(s.schedule.dueReason, 'paused');
  await h.advance(30 * MIN, p); // still waits; no override, no empty reset because a request is ready
  assert.equal(h.snap().schedule.phase, 'master');
  await h.ok(h.admin, 'playback.play', {});
  s = h.snap();
  assert.equal(s.schedule.phase, 'request');
  assert.equal(s.suspendedMaster?.positionSec, 1234.5);
});

test('buffering and offline count toward elapsed time; seeking never moves the period anchor', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  const anchor = h.snap().schedule.periodStartedAt;
  await h.advance(4 * MIN, p);
  await p.sync('buffering', 200);
  h.clock.advance(4 * MIN);
  await p.claim(); // the stalled player reconnects after its lease lapsed
  await h.ok(h.admin, 'playback.seek', { entryId: h.snap().nowPlaying!.entryId, positionSec: 3000 });
  await h.ok(h.admin, 'playback.seek', { entryId: h.snap().nowPlaying!.entryId, positionSec: 10 });
  assert.equal(h.snap().schedule.periodStartedAt, anchor);
  await submit(h, h.alice, URLS.r1);
  await h.advance(7 * MIN); // offline: lease expires; still elapsed
  assert.equal(h.snap().playback.observed?.status, 'offline');
  assert.equal(h.snap().schedule.phase, 'request', 'due transition happens server-side while the player is offline');
});

test('master exhaustion loops the list; failures are bounded; no usable master pauses with an alert', async () => {
  const h = harness();
  const p = await h.startNight([URLS.song, URLS.boundary]);
  assert.equal(h.snap().nowPlaying?.title, 'Master Song');
  await p.sync('ended', 200);
  assert.equal(h.snap().nowPlaying?.title, 'Exactly Six');
  await p.sync('ended', 360);
  assert.equal(h.snap().nowPlaying?.title, 'Master Song', 'loops');
  // Skipping a master item advances without resetting the accumulated period.
  const anchor = h.snap().schedule.periodStartedAt;
  await h.advance(MIN, p);
  await h.ok(h.admin, 'playback.skip', { entryId: h.snap().nowPlaying!.entryId });
  assert.equal(h.snap().nowPlaying?.title, 'Exactly Six');
  assert.equal(h.snap().schedule.periodStartedAt, anchor);
  // Each item fails twice → unusable; then playback pauses with an alert.
  for (let i = 0; i < 4; i++) await p.sync('error', 0);
  const s = h.snap();
  assert.equal(s.nowPlaying, null);
  assert.equal(s.schedule.intent, 'paused');
  assert.ok(s.alerts.some((a) => a.code === 'no_master_available'));
  assert.deepEqual(s.master?.map((m) => m.status), ['unusable', 'unusable']);
  await h.fails('NOTHING_PLAYABLE', h.admin, 'playback.play', {});
  // Requests are not drained outside their schedule while master is unavailable.
  await submit(h, h.alice, URLS.r1);
  await h.advance(60 * MIN);
  assert.equal(h.snap().schedule.phase, 'master');
});

test('short simulated period via policy override (production policy unchanged)', async () => {
  const h = harness({ periodMs: 1000 });
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await h.advance(1000, p);
  assert.equal(h.snap().schedule.phase, 'request');
  assert.equal(h.snap().schedule.periodMs, 1000);
  await p.sync('ended', 180);
  assert.equal(h.snap().schedule.phase, 'master');
});
