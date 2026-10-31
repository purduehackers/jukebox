// Paired-device lease/generation fencing, acknowledgement, reconnect, cache retention, restart.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIN, URLS, harness, player, submit } from './helpers.ts';

test('pairing codes are single-use and expire; public display gets no authority', async () => {
  const h = harness();
  const { code } = await h.ok(h.admin, 'device.pairing.create', { name: 'Wall' });
  await h.ok({ kind: 'public' }, 'device.pair', { code });
  await h.fails('PAIRING_INVALID', { kind: 'public' }, 'device.pair', { code });
  const late = await h.ok(h.admin, 'device.pairing.create', { name: 'Late' });
  h.clock.advance(10 * MIN);
  await h.fails('PAIRING_INVALID', { kind: 'public' }, 'device.pair', { code: late.code });
  await h.fails('UNAUTHENTICATED', { kind: 'public' }, 'player.claim', {});
  assert.equal(h.snap({ kind: 'public' }).lease, undefined);
});

test('one lease at a time; generation fences stale tabs, takeovers, revocation, and expiry', async () => {
  const h = harness();
  const p = await h.startNight();
  const other = await h.pairPlayer('Second laptop');
  await h.fails('LEASE_HELD', other.actor, 'player.claim', {});
  // Same device, second tab: explicit takeover only; old generation is fenced.
  const tab2 = player(h, p.deviceId);
  await h.fails('LEASE_HELD', tab2.actor, 'player.claim', {});
  await tab2.claim(true);
  const stale = await p.sync('playing', 5);
  assert.equal(!stale.ok && stale.error.code, 'STALE_LEASE');
  assert.ok((await tab2.sync('needs_activation', 0)).ok);
  // Lease expiry: offline, then another paired device may claim.
  h.clock.advance(15_000);
  await h.svc.reconcile();
  assert.equal(h.snap().playback.observed?.status, 'offline');
  assert.ok(h.snap().alerts.some((a) => a.code === 'player_offline'));
  await other.claim();
  const fenced = await tab2.report({ generation: tab2.generation, epoch: 0, loadId: 0, status: 'playing', positionSec: 0 });
  assert.equal(!fenced.ok && fenced.error.code, 'STALE_LEASE');
  assert.equal(h.snap(other.actor).lease?.deviceId, other.deviceId);
  // Revocation fences immediately and blocks re-claim.
  await h.ok(h.admin, 'device.revoke', { deviceId: other.deviceId });
  assert.equal(h.svc.snapshot(other.actor).lease, null);
  const revoked = await h.cmd(other.actor, 'player.report', { generation: other.generation, epoch: 0, loadId: 0, status: 'playing', positionSec: 0 });
  assert.equal(!revoked.ok && revoked.error.code, 'STALE_LEASE');
  assert.equal(h.svc.authenticateDevice(`${other.deviceId}.anything`), null);
});

test('requested vs confirmed: acknowledgement by epoch, unconfirmed after timeout, stale load reports ignored', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix, URLS.mix2]);
  assert.equal(h.snap().playback.confirmation, 'confirmed');
  await h.ok(h.admin, 'playback.pause', {});
  assert.equal(h.snap().playback.confirmation, 'requested', 'accepted by server, not yet by player');
  h.clock.advance(10_000);
  await h.svc.reconcile();
  assert.equal(h.snap().playback.confirmation, 'unconfirmed');
  assert.ok(h.snap().alerts.some((a) => a.code === 'unconfirmed_command'));
  await p.sync('paused', 10);
  assert.equal(h.snap().playback.confirmation, 'confirmed');
  // A late `ended` from an old load must not advance the new item.
  const oldLoad = p.desired()!.loadId;
  await h.ok(h.admin, 'playback.skip', { entryId: h.snap().nowPlaying!.entryId });
  const title = h.snap().nowPlaying!.title;
  const late = await p.report({ generation: p.generation, epoch: p.desired()!.epoch - 1, loadId: oldLoad, status: 'ended', positionSec: 3600 });
  assert.ok(late.ok);
  assert.equal(h.snap().nowPlaying!.title, title);
  // A report claiming a future epoch is rejected.
  const ahead = await p.report({ generation: p.generation, epoch: 999, loadId: p.desired()!.loadId, status: 'playing', positionSec: 0 });
  assert.equal(!ahead.ok && ahead.error.code, 'BAD_REQUEST');
  // `ended` racing an explicit replay (seek 0) does not skip the replayed item.
  await p.sync('playing', 2390);
  const before = p.desired()!;
  await h.ok(h.admin, 'playback.seek', { entryId: h.snap().nowPlaying!.entryId, positionSec: 0 });
  await p.report({ generation: p.generation, epoch: before.epoch, loadId: before.loadId, status: 'ended', positionSec: 2400 });
  assert.equal(h.snap().nowPlaying!.title, title, 'replay wins over a stale end');
});

test('reconnect: reload restores desired state at the checkpoint; refresh during a request finishes that request', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await submit(h, h.alice, URLS.r1);
  await h.advance(15 * MIN, p);
  await p.sync('playing', 60);
  const desired = p.desired()!;
  // Tab reloads: lease is lost (best-effort release did not arrive); wait for expiry and reclaim.
  h.clock.advance(15_000);
  await h.svc.reconcile();
  await p.claim();
  const restored = p.desired()!;
  assert.equal(restored.kind, 'request');
  assert.equal(restored.entryId, desired.entryId);
  assert.ok(h.snap().suspendedMaster, 'master still suspended and pinned');
  await p.sync('needs_activation', 0);
  assert.equal(h.snap().playback.observed?.status, 'needs_activation');
  await p.sync('ended', 180);
  assert.equal(h.snap().nowPlaying?.title, 'Hour Mix');
  assert.equal(h.snap().requests.find((r) => r.title === 'Request One')?.status, 'played', 'consumed exactly once');
});

test('cache retention pins the suspended mix and active request; releases finished/removed items', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix, URLS.song]);
  const masterAsset = () => JSON.parse((h.svc.db.prepare("select asset from master_items where title = 'Hour Mix'").get() as { asset: string }).asset).assetId;
  const mixAsset = masterAsset();
  await submit(h, h.alice, URLS.r1);
  await h.advance(15 * MIN, p);
  const requestAsset = p.desired()!.asset.assetId;
  await h.svc.reconcile();
  assert.ok(h.media.retained.assetIds.includes(mixAsset), 'suspended mix pinned during the request');
  assert.ok(h.media.retained.assetIds.includes(requestAsset));
  // Even while the player is offline, pins remain.
  h.clock.advance(60_000);
  await h.svc.reconcile();
  assert.ok(h.media.retained.assetIds.includes(mixAsset));
  await p.claim();
  await p.sync('ended', 180);
  await h.svc.reconcile();
  assert.ok(!h.media.retained.assetIds.includes(requestAsset), 'played request released');
  const song = h.snap().master!.find((m) => m.title === 'Master Song')!;
  await h.ok(h.admin, 'master.remove', { entryId: song.id });
  await h.svc.reconcile();
  assert.equal(h.media.retained.assetIds.length, 1);
  assert.ok(h.media.retained.revision > 1, 'monotonic retention revision');
});

test('restart preserves queues, checkpoints, and command replay; due transitions reconcile after restart', async () => {
  const h = harness();
  const p = await h.startNight([URLS.mix]);
  await h.advance(5 * MIN, p);
  const submitted = await h.cmd(h.alice, 'request.submit', { url: URLS.r1 }, { commandId: '11111111-2222-4333-8444-555555555555' });
  assert.ok(submitted.ok);
  await h.svc.reconcile();
  await p.sync('playing', 300);
  const before = h.snap();
  h.restart();
  const after = h.snap();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.requests, before.requests);
  assert.equal(after.schedule.periodStartedAt, before.schedule.periodStartedAt);
  const replay = await h.cmd(h.alice, 'request.submit', { url: URLS.r1 }, { commandId: '11111111-2222-4333-8444-555555555555' });
  assert.equal(replay.replayed, true);
  assert.equal(h.snap(h.alice).quota?.used, 1);
  // Service down across the due time: the first reconcile after restart performs the turn.
  h.svc.close();
  h.clock.advance(10 * MIN);
  h.svc = new (h.svc.constructor as typeof import('../src/server/service.ts').JukeboxService)({
    dbPath: `${h.dir}/state.sqlite3`, clock: h.clock, source: h.source, media: h.media,
  });
  await h.svc.reconcile();
  const s = h.snap();
  assert.equal(s.schedule.phase, 'request');
  assert.equal(s.suspendedMaster?.positionSec, 300, 'resume from the durable checkpoint');
  assert.equal(s.playback.observed?.status, 'offline');
  assert.throws(() => new (h.svc.constructor as typeof import('../src/server/service.ts').JukeboxService)({
    dbPath: `${h.dir}/state.sqlite3`, clock: h.clock, source: h.source, media: h.media,
  }), /Another Jukebox service/);
});
