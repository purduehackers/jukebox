import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { harness, URLS } from './helpers.ts';

const publicActor = { kind: 'public' } as const;
const secret = () => randomBytes(32).toString('hex');

test('an organizer display stays connected across nights, with no admin or attendee authority', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  const key = secret();
  const idle = await h.ok(h.admin, 'display.connect', { secret: key });
  assert.equal(h.snap({ kind: 'device', deviceId: idle.deviceId }).desired, null);
  await h.ok(h.admin, 'night.open', {});
  const connected = await h.ok(h.admin, 'display.connect', { secret: key });
  assert.equal(h.svc.authenticateDevice(connected.token), connected.deviceId);
  const actor = { kind: 'device', deviceId: connected.deviceId } as const;
  assert.equal(h.snap(actor).lease, null);
  await h.fails('FORBIDDEN', actor, 'night.close', {});
  await h.fails('FORBIDDEN', actor, 'master.add', { url: URLS.mix });
  await h.fails('FORBIDDEN', actor, 'request.submit', { url: URLS.r1 });
  assert.equal(h.snap(publicActor).lease, undefined);
  assert.equal((h.svc.db.prepare("select count(*) as n from commands where type='display.connect'").get() as { n: number }).n, 0);
  const persisted = JSON.stringify(h.svc.db.prepare('select * from devices').all());
  assert.ok(!persisted.includes(key), 'the page secret must only be stored hashed');
});

test('displays connect immediately and concurrently; retries and refreshes require no lease', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.svc.reconcile();
  await h.ok(h.admin, 'night.open', {});
  const key = secret();
  const first = await h.ok(h.admin, 'display.connect', { secret: key });
  const replay = await h.ok(h.admin, 'display.connect', { secret: key });
  assert.deepEqual(replay, first);
  const others = await Promise.all(Array.from({ length: 5 }, () => h.ok(h.admin, 'display.connect', { secret: secret() })));
  for (const device of [first, ...others]) {
    const actor = { kind: 'device', deviceId: device.deviceId } as const;
    const desired = h.snap(actor).desired!;
    assert.ok(desired);
    await h.ok(actor, 'player.report', { generation: device.generation, epoch: desired.epoch, loadId: desired.loadId, status: 'playing', positionSec: 42 });
    assert.equal(h.snap(actor).lease, null);
  }
  h.clock.advance(h.svc.policy.leaseMs * 3);
  h.svc.tick();
  const actor = { kind: 'device', deviceId: first.deviceId } as const;
  assert.equal(h.snap(actor).desired!.startPositionSec, 42, 'checkpoint survives report health expiry');
  const desired = h.snap(actor).desired!;
  await h.ok(actor, 'player.report', { generation: first.generation, epoch: desired.epoch, loadId: desired.loadId, status: 'playing', positionSec: 43 });
  assert.equal(h.snap().playback.observed!.status, 'playing');
  h.restart();
  assert.equal(h.svc.authenticateDevice(first.token), first.deviceId);
  assert.equal(h.snap(actor).desired!.startPositionSec, 43);
  await h.ok(h.admin, 'night.close', {});
  assert.equal(h.snap(actor).desired, null);
  await h.ok(h.admin, 'night.open', {});
  assert.ok(h.snap(actor).desired);
});

test('automatic registrations stay bounded without invalidating the other recent tabs', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  const devices = [];
  for (let i = 0; i < 40; i++) devices.push(await h.ok(h.admin, 'display.connect', { secret: secret() }));
  assert.equal((h.svc.db.prepare('select count(*) as n from devices where automatic=1').get() as { n: number }).n, 32);
  for (const device of devices.slice(-32)) assert.equal(h.svc.authenticateDevice(device.token), device.deviceId);
});

test('reload checkpoints cannot override a pending seek, and stale seek reports cannot rewind it', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.svc.reconcile();
  const device = await h.ok(h.admin, 'display.connect', { secret: secret() });
  h.svc.displayConnected(device.deviceId);
  await h.ok(h.admin, 'night.open', {});
  const actor = { kind: 'device', deviceId: device.deviceId } as const;
  const d = h.snap(actor).desired!;
  const report = { generation: device.generation, epoch: d.epoch, loadId: d.loadId, status: 'playing' as const, positionSec: 42 };
  await h.ok(actor, 'player.report', report);
  await h.ok(h.admin, 'playback.seek', { entryId: d.entryId, positionSec: 100 });
  await h.ok(actor, 'player.report', { ...report, status: 'ended', positionSec: 50 });
  assert.equal(h.snap(actor).desired!.startPositionSec, 100);
  assert.equal(h.snap().playback.confirmation, 'requested');
  await h.ok(actor, 'player.report', { ...report, epoch: h.snap(actor).desired!.epoch, positionSec: 101 });
  assert.equal(h.snap(actor).desired!.startPositionSec, 101);
});

test('session start plays a prepared master when a display is open, stays paused with 0 displays, and session end pauses it', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.svc.reconcile();
  assert.equal(h.snap().schedule.intent, 'paused');
  assert.equal(h.snap().openDisplays, 0);
  await h.ok(h.admin, 'night.open', {});
  assert.equal(h.snap().schedule.intent, 'paused', '0 displays open starts paused');
  assert.equal(h.snap().nowPlaying?.title, 'Hour Mix');
  await h.fails('NO_DISPLAY', h.admin, 'playback.play', {});
  await h.ok(h.admin, 'night.close', {});

  const display = await h.ok(h.admin, 'display.connect', { secret: secret() });
  h.svc.displayConnected(display.deviceId);
  assert.equal(h.snap().openDisplays, 1);
  await h.ok(h.admin, 'night.open', {});
  assert.equal(h.snap().schedule.intent, 'playing');
  assert.equal(h.snap().nowPlaying?.title, 'Hour Mix');
  assert.equal(h.snap().schedule.periodStartedAt, h.clock.now());
  await h.ok(h.admin, 'night.close', {});
  assert.equal(h.snap().schedule.intent, 'paused');
  assert.equal(h.snap().schedule.periodStartedAt, null);
  await h.ok(h.admin, 'night.open', {});
  assert.equal(h.snap().schedule.intent, 'playing');
});

test('session started before media is ready starts when prepared, survives restart, and respects explicit pause', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  const display = await h.ok(h.admin, 'display.connect', { secret: secret() });
  h.svc.displayConnected(display.deviceId);
  await h.ok(h.admin, 'night.open', {});
  h.restart();
  h.svc.displayConnected(display.deviceId);
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.svc.reconcile();
  assert.equal(h.snap().schedule.intent, 'playing');
  assert.equal(h.snap().nowPlaying?.title, 'Hour Mix');
  await h.ok(h.admin, 'night.close', {});
  await h.ok(h.admin, 'master.remove', { entryId: h.snap().master![0]!.id });
  await h.ok(h.admin, 'night.open', {});
  await h.ok(h.admin, 'playback.pause', {});
  await h.ok(h.admin, 'master.add', { url: URLS.song });
  await h.svc.reconcile();
  assert.equal(h.snap().schedule.intent, 'paused');
});

test('request reload restores its own checkpoint and duplicate display ends advance only once', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.ok(h.admin, 'night.open', {});
  const request = await h.ok(h.alice, 'request.submit', { url: URLS.r1 });
  await h.svc.reconcile();
  await h.ok(h.admin, 'request.playNow', { entryId: request.entryId });
  const page = await h.ok(h.admin, 'display.connect', { secret: secret() });
  const actor = { kind: 'device', deviceId: page.deviceId } as const;
  const d = h.snap(actor).desired!;
  const report = { generation: page.generation, epoch: d.epoch, loadId: d.loadId, status: 'paused' as const, positionSec: 70 };
  await h.ok(actor, 'player.report', report);
  h.restart();
  const reload = await h.ok(h.admin, 'display.connect', { secret: secret() });
  const other = { kind: 'device', deviceId: reload.deviceId } as const;
  assert.equal(h.snap(other).desired!.startPositionSec, 70);
  await h.ok(h.admin, 'playback.seek', { entryId: d.entryId, positionSec: 100 });
  assert.equal(h.snap(other).desired!.startPositionSec, 100);
  const current = h.snap(other).desired!;
  await h.ok(actor, 'player.report', { ...report, epoch: current.epoch, status: 'ended', positionSec: 180 });
  const resumed = h.snap(other).desired!;
  assert.equal(resumed.kind, 'master');
  await h.ok(other, 'player.report', { ...report, generation: reload.generation, epoch: current.epoch, status: 'ended', positionSec: 180 });
  assert.equal(h.snap(other).desired!.loadId, resumed.loadId);
  assert.equal(h.snap(h.alice).quota!.used, 1);
});

test('closed nights never wait for playback acknowledgement or show stale player alerts', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  const player = await h.startNight();
  await player.heartbeat(1000);
  await h.ok(h.admin, 'night.close', {});
  h.clock.advance(h.svc.policy.leaseMs * 2);
  h.svc.tick();
  const closed = h.snap();
  assert.equal(closed.playback.confirmation, 'none');
  assert.equal(closed.playback.desiredEpoch, null);
  assert.equal(closed.alerts.length, 0);
});

test('alternating paused displays cannot move the checkpoint, while explicit seeks still apply', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.svc.reconcile();
  await h.ok(h.admin, 'night.open', {});
  await h.ok(h.admin, 'playback.pause', {});
  const a = await h.ok(h.admin, 'display.connect', { secret: secret() });
  const b = await h.ok(h.admin, 'display.connect', { secret: secret() });
  h.svc.displayConnected(a.deviceId);
  h.svc.displayConnected(b.deviceId);
  const actor = (device: typeof a) => ({ kind: 'device' as const, deviceId: device.deviceId });
  const report = async (device: typeof a, positionSec: number) => {
    const d = h.snap(actor(device)).desired!;
    await h.ok(actor(device), 'player.report', { generation: device.generation, loadId: d.loadId, epoch: d.epoch, status: 'paused', positionSec });
  };
  await report(a, 295);
  for (let i = 0; i < 6; i++) {
    h.clock.advance(2500);
    await report(b, 318);
    assert.equal(h.snap().playback.observed!.positionSec, 295);
    await report(a, 295);
    assert.equal(h.snap(actor(b)).desired!.startPositionSec, 295);
  }
  await h.ok(h.admin, 'playback.seek', { entryId: h.snap().nowPlaying!.entryId, positionSec: 200 });
  await report(a, 200);
  await report(b, 295);
  assert.equal(h.snap().playback.observed!.positionSec, 200);
  assert.equal(h.snap().playback.confirmation, 'confirmed');
  assert.ok(h.snap(actor(a)).desired);
  assert.ok(h.snap(actor(b)).desired);
});


test('public visitors and attendees cannot register an automatic player', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.fails('UNAUTHENTICATED', publicActor, 'display.connect', { secret: secret() });
  await h.fails('FORBIDDEN', h.alice, 'display.connect', { secret: secret() });
  assert.equal((h.svc.db.prepare('select count(*) as n from devices').get() as { n: number }).n, 0);
});

test('display receives attribution only for the playing request', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  const player = await h.startNight([URLS.mix]);
  const submitted = await h.ok(h.alice, 'request.submit', { url: URLS.r1 });
  await h.svc.reconcile();
  assert.equal(h.snap(player.actor).requests.find(r => r.id === submitted.entryId)?.requester, undefined);
  await h.ok(h.admin, 'request.playNow', { entryId: submitted.entryId });
  assert.equal(h.snap(player.actor).requests.find(r => r.id === submitted.entryId)?.requester, 'alice');
  assert.equal(h.snap(publicActor).requests.find(r => r.id === submitted.entryId)?.requester, undefined);
});

test('music pauses when open displays drop to 0 after reload grace, stays paused on reopen, and survives quick reload', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.svc.reconcile();
  const a = await h.ok(h.admin, 'display.connect', { secret: secret() });
  const b = await h.ok(h.admin, 'display.connect', { secret: secret() });
  h.svc.displayConnected(a.deviceId);
  h.svc.displayConnected(b.deviceId);
  await h.ok(h.admin, 'night.open', {});
  assert.equal(h.snap().schedule.intent, 'playing');
  assert.equal(h.snap().openDisplays, 2);

  // Closing one of two displays keeps music playing.
  h.svc.displayDisconnected(a.deviceId);
  h.clock.advance(h.svc.policy.noDisplayPauseMs + 1000);
  h.svc.tick();
  assert.equal(h.snap().schedule.intent, 'playing');
  assert.equal(h.snap().openDisplays, 1);

  // Quick reload of the last display within grace window does not pause music.
  h.svc.displayDisconnected(b.deviceId);
  h.clock.advance(h.svc.policy.noDisplayPauseMs - 500);
  h.svc.tick();
  assert.equal(h.snap().schedule.intent, 'playing');
  const reloaded = await h.ok(h.admin, 'display.connect', { secret: secret() });
  h.svc.displayConnected(reloaded.deviceId);
  h.clock.advance(h.svc.policy.noDisplayPauseMs + 1000);
  h.svc.tick();
  assert.equal(h.snap().schedule.intent, 'playing');

  // Closing the last display for longer than the grace window pauses music.
  h.svc.displayDisconnected(reloaded.deviceId);
  assert.equal(h.snap().openDisplays, 0);
  h.clock.advance(h.svc.policy.noDisplayPauseMs);
  h.svc.tick();
  assert.equal(h.snap().schedule.intent, 'paused');
  assert.equal(h.snap().playback.confirmation, 'none');
  assert.ok(h.svc.events(0).some((e) => e.type === 'playback.paused_no_display'));
  await h.fails('NO_DISPLAY', h.admin, 'playback.play', {});

  // Opening a display again stays paused until an organizer explicitly presses Play.
  const reopened = await h.ok(h.admin, 'display.connect', { secret: secret() });
  h.svc.displayConnected(reopened.deviceId);
  assert.equal(h.snap().openDisplays, 1);
  assert.equal(h.snap().schedule.intent, 'paused');
  await h.ok(h.admin, 'playback.play', {});
  assert.equal(h.snap().schedule.intent, 'playing');
});

test('automatic display heartbeat expiry with 0 open display streams (e.g. after restart) pauses playback', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.svc.reconcile();
  const d = await h.ok(h.admin, 'display.connect', { secret: secret() });
  const actor = { kind: 'device', deviceId: d.deviceId } as const;
  h.svc.displayConnected(d.deviceId);
  await h.ok(h.admin, 'night.open', {});
  const desired = h.snap(actor).desired!;
  await h.ok(actor, 'player.report', { generation: d.generation, epoch: desired.epoch, loadId: desired.loadId, status: 'playing', positionSec: 25 });
  assert.equal(h.snap().schedule.intent, 'playing');
  // Service restarts and no display reconnects.
  h.restart();
  assert.equal(h.snap().openDisplays, 0);
  h.clock.advance(h.svc.policy.leaseMs);
  h.svc.tick();
  assert.equal(h.snap().playback.observed?.status, 'offline');
  assert.equal(h.snap().schedule.intent, 'paused');
});
