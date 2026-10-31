// contract-proposal: request.preview is read-only and mirrors submit's validation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PortError } from '../src/core/ports.ts';
import { URLS, harness, submit } from './helpers.ts';

test('preview resolves without reserving allowance, changing the queue, or bumping the revision', async () => {
  const h = harness();
  await h.startNight();
  const revision = h.svc.revision();
  const commands = (h.svc.db.prepare('select count(*) as n from commands').get() as { n: number }).n;
  const result = await h.ok(h.alice, 'request.preview', { url: URLS.r1Alt });
  assert.deepEqual(result.verdict, { accepted: true });
  assert.equal(result.source.title, 'Request One');
  assert.equal(result.source.canonicalUrl, 'https://www.youtube.com/watch?v=REQreqreq01');
  assert.deepEqual(result.quota, { used: 0, limit: 3, remaining: 3 });
  assert.equal(h.svc.revision(), revision);
  assert.equal((h.svc.db.prepare('select count(*) as n from commands').get() as { n: number }).n, commands, 'previews are not stored');
  assert.equal(h.snap(h.alice).quota?.used, 0);
  assert.equal(h.snap(h.alice).requests.length, 0);
});

test('preview reports duration and duplicate rejections as a verdict, and mirrors submit errors', async () => {
  const h = harness();
  await h.startNight();
  const long = await h.ok(h.alice, 'request.preview', { url: URLS.long });
  assert.equal(long.source.title, 'Too Long');
  assert.deepEqual(long.verdict, { accepted: false, code: 'DURATION_REJECTED', message: 'Requests must be shorter than six minutes' });
  assert.ok((await submit(h, h.bob, URLS.r1)).ok);
  const dup = await h.ok(h.alice, 'request.preview', { url: URLS.sameRecording });
  assert.equal(dup.verdict.accepted, false);
  assert.equal(!dup.verdict.accepted && dup.verdict.code, 'DUPLICATE_REQUEST');
  await h.fails('INVALID_SOURCE', h.alice, 'request.preview', { url: 'http://youtu.be/REQreqreq01' });
  await h.fails('SOURCE_UNSUPPORTED', h.alice, 'request.preview', { url: 'https://www.youtube.com/playlist?list=PL1' });
  await h.fails('SOURCE_UNAVAILABLE', h.alice, 'request.preview', { url: 'https://youtu.be/NOTinCATALG' });
  await h.fails('UNAUTHENTICATED', { kind: 'public' }, 'request.preview', { url: URLS.r1 });
  for (const url of [URLS.r2, URLS.r3, URLS.almost]) assert.ok((await submit(h, h.alice, url)).ok);
  await h.fails('QUOTA_EXCEEDED', h.alice, 'request.preview', { url: URLS.r4 });
  await h.ok(h.admin, 'night.close', {});
  await h.fails('NIGHT_CLOSED', h.bob, 'request.preview', { url: URLS.r4 });
});

test('preview is rate limited per identity, not globally', async () => {
  const h = harness();
  h.svc.close();
  const { JukeboxService } = await import('../src/server/service.ts');
  h.svc = new JukeboxService({ dbPath: ':memory:', clock: h.clock, source: h.source, media: h.media, previewLimit: { max: 2, windowMs: 10_000 } });
  await h.ok(h.admin, 'night.open', {});
  await h.ok(h.alice, 'request.preview', { url: URLS.r1 });
  await h.ok(h.alice, 'request.preview', { url: URLS.r1 });
  const limited = await h.fails('RATE_LIMITED', h.alice, 'request.preview', { url: URLS.r1 });
  assert.equal(!limited.ok && limited.error.retryable, true);
  await h.ok(h.bob, 'request.preview', { url: URLS.r1 });
  assert.equal(h.source.resolveCalls, 3, 'rate-limited calls never reach the resolver');
  h.clock.advance(10_001);
  await h.ok(h.alice, 'request.preview', { url: URLS.r1 });
});

test('submit with expectRecordingKey refuses a link that now resolves to another recording', async () => {
  const h = harness();
  await h.startNight();
  const seen = await h.ok(h.alice, 'request.preview', { url: URLS.r1 });
  h.source.add(URLS.r1, { title: 'Request One (Live)', durationSec: 190, recordingKey: 'youtube:other-version' });
  await h.fails('GUARD_MISMATCH', h.alice, 'request.submit', { url: URLS.r1, expectRecordingKey: seen.source.recordingKey });
  assert.equal(h.snap(h.alice).quota?.used, 0);
  const again = await h.ok(h.alice, 'request.preview', { url: URLS.r1 });
  assert.ok((await h.cmd(h.alice, 'request.submit', { url: URLS.r1, expectRecordingKey: again.source.recordingKey })).ok);
});

test('structured PortError details reach the API error and are replayed with the stored response', async () => {
  const h = harness();
  await h.startNight();
  const details = { kind: 'ambiguous', candidates: [{ url: URLS.r1 }] };
  h.source.failNext = new PortError('SOURCE_UNAVAILABLE', 'Several recordings match', false, details);
  const failed = await h.fails('SOURCE_UNAVAILABLE', h.alice, 'request.preview', { url: URLS.r2 });
  assert.deepEqual(!failed.ok && failed.error.details, details);
  h.source.failNext = new PortError('SOURCE_UNAVAILABLE', 'Several recordings match', false, details);
  const id = '11111111-1111-4111-8111-111111111111';
  const first = await h.cmd(h.alice, 'request.submit', { url: URLS.r2 }, { commandId: id });
  const second = await h.cmd(h.alice, 'request.submit', { url: URLS.r2 }, { commandId: id });
  assert.equal(second.replayed, true);
  assert.deepEqual(!second.ok && second.error.details, details);
  assert.equal(first.ok, false);
});
