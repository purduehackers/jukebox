import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, URLS } from './helpers.ts';
import { metricsResponse } from '../src/server/metrics.ts';
import { createTransport } from '../src/server/transport.ts';
import { FakeIdentity } from '../src/adapters/fakes.ts';

test('public metrics exposition has bounded labels, zero series and no private data', async () => {
  const h = harness();
  const transport = createTransport({ service: h.svc, identity: new FakeIdentity(), origin: 'http://localhost' });
  try {
    const response = await transport.handle(new Request('http://localhost/metrics'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.ok(body.endsWith('\n'));
    assert.match(body, /# TYPE jukebox_queue_length gauge/);
    assert.match(body, /# TYPE jukebox_songs_submitted_total counter/);
    assert.equal(body.split('\n').filter(line => line.startsWith('jukebox_')).length, 13);
    assert.match(body, /source="apple_music"} 0/);
    assert.match(body, /source="deezer"} 0/);
    assert.doesNotMatch(body, /username|requester|title|https:/);
  } finally { transport.close(); h.svc.close(); }
});

test('admissions counted once across replay, removal, closed nights and restart', async () => {
  const h = harness();
  const body = () => metricsResponse(h.svc.db).text();
  try {
    await h.ok(h.admin, 'night.open', {});
    const commandId = randomUUID();
    const entry = await h.ok(h.alice, 'request.submit', { url: URLS.r1 }, { commandId });
    await h.ok(h.alice, 'request.submit', { url: URLS.r1 }, { commandId });
    await h.fails('DUPLICATE_REQUEST', h.bob, 'request.submit', { url: URLS.r1 });
    assert.match(await body(), /jukebox_queue_length\{queue="request"} 1/);
    await h.svc.reconcile();
    await h.ok(h.admin, 'request.remove', { entryId: entry.entryId });
    await h.ok(h.admin, 'night.close', {});
    await h.svc.reconcile();
    h.restart();
    const result = await body();
    assert.match(result, /jukebox_queue_length\{queue="request"} 0/);
    assert.match(result, /jukebox_songs_submitted_total\{queue="request",source="youtube"} 1/);
  } finally { await h.svc.reconcile(); h.svc.close(); }
});

test('waiting master gauge excludes current and suspended playback; original provider is counted', async () => {
  const h = harness();
  try {
    await h.startNight([URLS.mix, URLS.song]);
    assert.match(await metricsResponse(h.svc.db).text(), /jukebox_queue_length\{queue="master"} 1/);
    const resolve = h.source.resolve.bind(h.source);
    h.source.resolve = async (ref, purpose) => ref.provider === 'spotify'
      ? { ...(await resolve(h.source.canonicalize(URLS.r1), purpose)), ref }
      : resolve(ref, purpose);
    const request = await h.ok(h.alice, 'request.submit', { url: URLS.spotify });
    await h.svc.reconcile();
    await h.ok(h.admin, 'request.playNow', { entryId: request.entryId });
    const result = await metricsResponse(h.svc.db).text();
    assert.match(result, /jukebox_queue_length\{queue="master"} 1/);
    assert.match(result, /jukebox_queue_length\{queue="request"} 0/);
    assert.match(result, /jukebox_songs_submitted_total\{queue="request",source="spotify"} 1/);
  } finally { await h.svc.reconcile(); h.svc.close(); }
});


test('playing gauge follows server play/pause intent and night close', async () => {
  const h = harness();
  const check = async (value: number) => {
    assert.match(await metricsResponse(h.svc.db).text(), new RegExp(`^jukebox_playing ${value}$`, 'm'));
  };
  try {
    await check(0);
    await h.startNight();
    await check(1);
    await h.ok(h.admin, 'playback.pause', {});
    await check(0);
    await h.ok(h.admin, 'playback.play', {});
    await check(1);
    await h.ok(h.admin, 'night.close', {});
    await check(0);
  } finally { await h.svc.reconcile(); h.svc.close(); }
});
