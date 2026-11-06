import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayFixture, fixtureStates } from '../app/src/display/fixtures.ts';
import { displayModel, duration, requestUrl, safeArtwork } from '../app/src/display/model.ts';

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
test('display progress follows its local audio instead of alternating remote paused reports', async (t) => {
  const { harness, URLS } = await import('./helpers.ts');
  const h = harness(); t.after(() => h.svc.close());
  const player = await h.startNight([URLS.mix]);
  const snapshot = h.snap(player.actor);
  const desired = snapshot.desired!;
  const local = { loadId: desired.loadId, epoch: desired.epoch, status: 'paused' as const, positionSec: 318 };
  snapshot.playback.confirmation = 'confirmed';
  for (const position of [295, 318, 295, 318, 295]) {
    snapshot.playback.observed!.positionSec = position;
    assert.equal(displayModel(snapshot, snapshot.serverTime, false, local).progress, 318);
    assert.equal(displayModel(snapshot, snapshot.serverTime, false, local).status, 'paused');
  }
  assert.equal(displayModel(snapshot, snapshot.serverTime, false, { ...local, epoch: desired.epoch - 1 }).progress, 295,
    'an old local load/intent cannot describe the next track or seek');
  assert.equal(displayModel(snapshot, snapshot.serverTime, false, { ...local, positionSec: 200 }).progress, 200,
    'native seeked position is reflected immediately');
});
