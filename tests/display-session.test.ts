import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { harness, URLS } from './helpers.ts';

const publicActor = { kind: 'public' } as const;
const secret = () => randomBytes(32).toString('hex');

test('a display connects itself only in a session, with no admin or attendee authority', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  const key = secret();
  await h.fails('NIGHT_CLOSED', publicActor, 'display.connect', { secret: key });
  await h.ok(h.admin, 'night.open', {});
  const connected = await h.ok(publicActor, 'display.connect', { secret: key });
  assert.equal(h.svc.authenticateDevice(connected.token), connected.deviceId);
  const actor = { kind: 'device', deviceId: connected.deviceId } as const;
  assert.equal(h.snap(actor).lease?.generation, connected.generation);
  await h.fails('FORBIDDEN', actor, 'night.close', {});
  await h.fails('FORBIDDEN', actor, 'master.add', { url: URLS.mix });
  await h.fails('FORBIDDEN', actor, 'request.submit', { url: URLS.r1 });
  assert.equal(h.snap(publicActor).lease, undefined);
  assert.equal(h.svc.db.prepare("select count(*) as n from commands where type='display.connect'").get()!.n, 0);
  const persisted = JSON.stringify(h.svc.db.prepare('select * from devices').all());
  assert.ok(!persisted.includes(key), 'the page secret must only be stored hashed');
});

test('concurrent displays cannot steal audio; retries recover a lost response; registrations stay bounded', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'night.open', {});
  const key = secret();
  const first = await h.ok(publicActor, 'display.connect', { secret: key });
  const replay = await h.ok(publicActor, 'display.connect', { secret: key });
  assert.deepEqual(replay, first);
  await Promise.all(Array.from({ length: 5 }, () => h.fails('LEASE_HELD', publicActor, 'display.connect', { secret: secret() })));
  assert.equal(h.svc.db.prepare('select count(*) as n from devices where automatic=1').get()!.n, 1);
  h.clock.advance(h.svc.policy.leaseMs + 1);
  const replacement = await h.ok(publicActor, 'display.connect', { secret: secret() });
  assert.ok(replacement.generation > first.generation);
  assert.equal(h.svc.authenticateDevice(first.token), null);
  assert.equal(h.svc.db.prepare('select count(*) as n from devices where automatic=1').get()!.n, 1);
  await h.ok(h.admin, 'night.close', {});
  await h.fails('NIGHT_CLOSED', publicActor, 'display.connect', { secret: secret() });
});

test('session start plays a prepared master and session end pauses it', async (t) => {
  const h = harness(); t.after(() => h.svc.close());
  await h.ok(h.admin, 'master.add', { url: URLS.mix });
  await h.svc.reconcile();
  assert.equal(h.snap().schedule.intent, 'paused');
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
  await h.ok(h.admin, 'night.open', {});
  h.restart();
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
