import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URLS, harness, submit } from './helpers.ts';

test('artwork metadata persists and nextMaster is public-safe across a request turn', async () => {
  const h = harness();
  h.source.catalog.get(h.source.canonicalize(URLS.mix).canonicalUrl)!.artworkUrl = 'https://img.example/mix.jpg';
  h.source.catalog.get(h.source.canonicalize(URLS.mix2).canonicalUrl)!.artworkUrl = 'http://img.example/next.jpg';
  h.source.catalog.get(h.source.canonicalize(URLS.r1).canonicalUrl)!.artworkUrl = 'https://img.example/request.jpg';
  const p = await h.startNight([URLS.mix, URLS.mix2]);

  let publicSnapshot = h.snap({ kind: 'public' });
  assert.equal(publicSnapshot.nowPlaying?.artworkUrl, 'https://img.example/mix.jpg');
  assert.deepEqual(publicSnapshot.nextMaster, {
    title: 'Second Mix', artist: null, durationSec: 2400, artworkUrl: 'http://img.example/next.jpg',
  });

  await submit(h, h.alice, URLS.r1);
  assert.equal(h.snap({ kind: 'public' }).requests[0]?.artworkUrl, 'https://img.example/request.jpg');
  await h.advance(15 * 60_000, p);
  publicSnapshot = h.snap({ kind: 'public' });
  assert.equal(publicSnapshot.nowPlaying?.kind, 'request');
  assert.deepEqual(publicSnapshot.nextMaster, {
    title: 'Hour Mix', artist: null, durationSec: 3600, artworkUrl: 'https://img.example/mix.jpg',
  });
  assert.deepEqual(Object.keys(publicSnapshot.nextMaster!).sort(), ['artist', 'artworkUrl', 'durationSec', 'title']);

  h.restart();
  const afterRestart = h.snap({ kind: 'public' });
  assert.equal(afterRestart.nowPlaying?.artworkUrl, 'https://img.example/request.jpg');
  assert.equal(afterRestart.nextMaster?.artworkUrl, 'https://img.example/mix.jpg');
  assert.equal(afterRestart.requests[0]?.requester, undefined);
  assert.equal(afterRestart.master, undefined);
  assert.equal(afterRestart.devices, undefined);
});

test('resolver artwork URLs reject unsafe schemes before persistence', async () => {
  const h = harness();
  h.source.catalog.get(h.source.canonicalize(URLS.mix).canonicalUrl)!.artworkUrl = 'https://user:secret@img.example/cover.jpg';
  const credentialResult = await h.cmd(h.admin, 'master.add', { url: URLS.mix });
  assert.equal(credentialResult.ok, false);
  h.source.catalog.get(h.source.canonicalize(URLS.mix).canonicalUrl)!.artworkUrl = 'data:image/png;base64,AAAA';
  const result = await h.cmd(h.admin, 'master.add', { url: URLS.mix });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /invalid artwork URL/i);
  assert.equal((h.svc.db.prepare('select count(*) as n from master_items').get() as { n: number }).n, 0);
});

test('pre-artwork database upgrades without losing existing queue/checkpoint state', async () => {
  const h = harness();
  await h.startNight();
  await submit(h, h.alice, URLS.r1);
  const before = h.snap({ kind: 'public' });
  // Recreate the previous schema with real existing queue rows, then reopen.
  h.svc.db.exec('alter table playback drop column period_paused_at; drop table banned_usernames; alter table master_items drop column artwork_url; alter table requests drop column artwork_url; alter table devices drop column automatic; alter table playback drop column autostart; alter table playback drop column mode; alter table playback drop column period_ms; pragma user_version = 1');
  h.restart();
  const after = h.snap({ kind: 'public' });
  assert.deepEqual(after.nowPlaying, before.nowPlaying);
  assert.deepEqual(after.requests, before.requests);
  assert.deepEqual(after.schedule, before.schedule);
  assert.equal(after.nowPlaying?.artworkUrl, undefined);
  h.svc.close();
});
