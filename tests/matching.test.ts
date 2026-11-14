import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MediaPurpose, SourceRef } from '../src/contract/types.ts';
import { FakeClock, FakeMedia, FakeSource } from '../src/adapters/fakes.ts';
import { DEMO_YOUTUBE_LINKS, FixtureCandidateSearch, FixtureCatalog, MATCHING_FIXTURE_URLS, UnconfiguredCatalog, fixtureMatchingSource } from '../src/adapters/matching-fixtures.ts';
import { baseTitle, candidateMatchesTitleArtist, detectMarkers, durationMatches, normalizeText } from '../src/adapters/matching-core.ts';
import { MatchingSource } from '../src/adapters/matching-source.ts';
import { PortError, type SourcePort } from '../src/core/ports.ts';
import { canonicalizeUrl } from '../src/core/sources.ts';
import { JukeboxService } from '../src/server/service.ts';

test('normalization removes diacritics and punctuation; title base drops feat and hard versions', () => {
  assert.equal(normalizeText('Beyoncé—Live!'), 'beyonce live');
  assert.equal(baseTitle('Song Title (Live) feat. Guest Artist'), 'song title');
  assert.deepEqual(detectMarkers('Song [Radio Edit] — Remastered'), ['radio edit']);
  assert.deepEqual(detectMarkers('Song (8D) - Nightcore'), ['nightcore', '8d']);
});

test('clean Spotify, Apple, and Deezer catalog links match the same audio-only YouTube upload', async () => {
  const source = matching(new FakeSource().add('https://youtu.be/GFOtrack001', { title: 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: 212, recordingKey: 'same-recording' }));
  for (const url of [MATCHING_FIXTURE_URLS.spotify, MATCHING_FIXTURE_URLS.apple, MATCHING_FIXTURE_URLS.deezer]) {
    const result = await source.resolve(source.canonicalize(url), 'request');
    assert.equal(result.title, 'A New Kind Of Love (pt. 1)');
    assert.equal(result.ref.canonicalUrl, canonicalizeUrl(url).canonicalUrl);
    assert.equal(result.recordingKey, 'same-recording');
    assert.equal(result.match?.url, 'https://www.youtube.com/watch?v=GFOtrack001');
    assert.equal((result.selection as { matchedFrom: string }).matchedFrom, canonicalizeUrl(url).canonicalUrl);
  }
});

test('version conflicts, absent matches, and different edits return structured details', async () => {
  const source = matching(new FakeSource());
  await expectMatchError(source, MATCHING_FIXTURE_URLS.live, 'version_mismatch');
  await expectMatchError(source, MATCHING_FIXTURE_URLS.studio, 'version_mismatch');
  await assert.rejects(source.resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.missing), 'request'), (error: unknown) => error instanceof PortError && error.code === 'SOURCE_UNAVAILABLE' && error.message.includes("isn't in the catalog"));
});

test('a cover distractor does not win; topic upload is preferred among equivalents', async () => {
  const fake = new FakeSource()
    .add('https://youtu.be/REALsong001', { title: 'Borrowed Time', durationSec: 180 })
    .add('https://youtu.be/GFOtrack001', { title: 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: 212 });
  const result = await matching(fake).resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.cover), 'request');
  assert.match(result.match?.url ?? '', /REALsong001/);
  const chosen = await matching(fake).resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify), 'request');
  assert.match(chosen.match?.url ?? '', /GFOtrack001/);
});

test('equivalent uploads use first search order and explain the selection', async () => {
  const inner = new FakeSource()
    .add('https://youtu.be/FIRSTsong01', { title: 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: 212 })
    .add('https://youtu.be/SECONDsong1', { title: 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: 214 });
  const search = {
    search: async () => [
      { url: 'https://youtu.be/FIRSTsong01', title: 'A New Kind Of Love Pt 1', channel: 'Ghost Funk Orchestra', durationSec: 212 },
      { url: 'https://youtu.be/SECONDsong1', title: 'A New Kind Of Love Pt 1', channel: 'Ghost Funk Orchestra', durationSec: 214 },
    ],
  };
  const source = new MatchingSource(inner, new FixtureCatalog(), search);
  const result = await source.resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify), 'request');
  assert.match(result.match?.url ?? '', /FIRSTsong01/);
  assert.ok(result.match?.reasons.some((reason) => reason.includes('several equivalent uploads')));
});

test('candidate search results are canonicalized and unsafe candidates are ignored', async () => {
  const catalog = new FixtureCatalog();
  const results = [
    { url: 'https://example.com/watch?v=GFOtrack001', title: 'A New Kind Of Love Pt 1', channel: 'Ghost Funk Orchestra', durationSec: 212 },
    { url: 'not a URL', title: 'A New Kind Of Love Pt 1', channel: 'Ghost Funk Orchestra', durationSec: 212 },
  ];
  const source = new MatchingSource(new FakeSource(), catalog, { search: async () => results });
  await expectMatchError(source, MATCHING_FIXTURE_URLS.spotify, 'no_match');
});

test('matching never calls fetch, including catalog and search failures', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('fetch must not run'); }) as unknown as typeof fetch;
  try {
    const source = matching(new FakeSource().add('https://youtu.be/GFOtrack001', { title: 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: 212 }));
    await source.resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify), 'request');
    await assert.rejects(new MatchingSource(new FakeSource(), { lookup: async () => { throw new PortError('SOURCE_UNAVAILABLE', 'catalog failure'); } }, new FixtureCandidateSearch()).resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify), 'request'), /catalog failure/);
  } finally {
    globalThis.fetch = previous;
  }
});

test('technical errors propagate; unknown errors become retryable temporary failures', async () => {
  const ref = canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify);
  const original = new FakeSource();
  const failed = new MatchingSource(original, new FixtureCatalog(), { search: async () => { throw new PortError('SOURCE_UNAVAILABLE', 'search offline', true); } });
  await assert.rejects(failed.resolve(ref, 'request'), (error: unknown) => error instanceof PortError && error.message === 'search offline' && error.technical);
  const unknown = new MatchingSource(original, new FixtureCatalog(), { search: async () => { throw new Error('secret'); } });
  await assert.rejects(unknown.resolve(ref, 'request'), (error: unknown) => error instanceof PortError && error.message === 'Matching is temporarily unavailable' && error.technical);
});

test('non-catalog sources delegate untouched to inner source', async () => {
  const fake = new FakeSource().add('https://youtu.be/GFOtrack001', { title: 'Song', durationSec: 212 });
  const source = matching(fake);
  const ref = source.canonicalize('https://youtu.be/GFOtrack001');
  assert.equal((await source.resolve(ref, 'request')).title, 'Song');
  assert.equal(fake.resolveCalls, 1);
});

test('service preview, submission, duplicate detection, errors, quota, and unconfigured catalog', async () => {
  const clock = new FakeClock();
  const candidateUrl = 'https://youtu.be/GFOtrack001';
  const inner = new FakeSource().add(candidateUrl, { title: 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: 212, recordingKey: 'same-recording' });
  const media = new FakeMedia();
  const svc = new JukeboxService({ dbPath: ':memory:', clock, source: matching(inner), media });
  const admin = { kind: 'user' as const, identity: { key: 'test#admin', issuer: 'test', subject: 'admin', displayName: 'admin', roles: ['organizer'] } };
  const alice = { kind: 'user' as const, identity: { key: 'test#alice', issuer: 'test', subject: 'alice', displayName: 'alice', roles: [] } };
  try {
    await run(svc, admin, 'night.open', {});
    const preview = await run(svc, alice, 'request.preview', { url: MATCHING_FIXTURE_URLS.spotify });
    assert.equal(preview.ok && preview.result.source.title, 'A New Kind Of Love (pt. 1)');
    assert.ok(preview.ok && preview.result.match?.url.includes('GFOtrack001'));
    const submitted = await run(svc, alice, 'request.submit', { url: MATCHING_FIXTURE_URLS.spotify });
    assert.ok(submitted.ok);
    const snapshot = svc.snapshot(alice);
    assert.equal(snapshot.requests[0]?.sourceUrl, canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify).canonicalUrl);
    assert.equal(snapshot.quota?.used, 1);
    const duplicate = await run(svc, alice, 'request.submit', { url: candidateUrl });
    assert.equal(!duplicate.ok && duplicate.error.code, 'DUPLICATE_REQUEST');
    assert.equal(svc.snapshot(alice).quota?.used, 1);

    const errorService = new JukeboxService({ dbPath: ':memory:', clock, source: matching(inner), media });
    await run(errorService, admin, 'night.open', {});
    for (const [url, kind] of [[MATCHING_FIXTURE_URLS.live, 'version_mismatch']] as const) {
      const response = await run(errorService, alice, 'request.submit', { url });
      assert.equal(!response.ok && response.error.details?.kind, kind);
    }
    assert.equal(errorService.snapshot(alice).quota?.used, 0);
    errorService.close();

    const unconfigured = new JukeboxService({ dbPath: ':memory:', clock, source: new MatchingSource(inner, new UnconfiguredCatalog(), new FixtureCandidateSearch()), media });
    await run(unconfigured, admin, 'night.open', {});
    const unsupported = await run(unconfigured, alice, 'request.preview', { url: MATCHING_FIXTURE_URLS.spotify });
    assert.equal(!unsupported.ok && unsupported.error.code, 'SOURCE_UNSUPPORTED');
    unconfigured.close();
  } finally {
    svc.close();
  }
});

function matching(inner: SourcePort): MatchingSource {
  return new MatchingSource(inner, new FixtureCatalog(), new FixtureCandidateSearch());
}

async function expectMatchError(source: SourcePort, url: string, kind: string): Promise<void> {
  await assert.rejects(source.resolve(source.canonicalize(url), 'request'), (error: unknown) => {
    assert.ok(error instanceof PortError);
    assert.equal(error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(error.details?.kind, kind);
    return true;
  });
}

async function run<T extends 'night.open' | 'request.preview' | 'request.submit'>(service: JukeboxService, actor: Parameters<JukeboxService['execute']>[0], type: T, payload: T extends 'night.open' ? Record<string, never> : { url: string }) {
  return service.execute(actor, { commandId: crypto.randomUUID(), type, payload } as never) as Promise<any>;
}

test('title and artist match whole words: "Love" is not "Lovely Day"; "Video Games" survives noise stripping', async () => {
  const track = { provider: 'spotify' as const, itemId: 'X'.repeat(22), title: 'Love', artists: ['Eve'], durationMs: 200_000 };
  const upload = (title: string, channel: string) => ({ url: 'https://www.youtube.com/watch?v=abcdefghijk', title, channel, durationSec: 200 });
  assert.equal(candidateMatchesTitleArtist(track, upload('Lovely Day', 'Eve')), false, 'title is a substring of another word');
  assert.equal(candidateMatchesTitleArtist(track, upload('Love', 'Steve')), false, 'artist is a substring of another word');
  assert.equal(candidateMatchesTitleArtist(track, upload('Love (Official Audio)', 'Eve - Topic')), true);
  const games = { ...track, title: 'Video Games', artists: ['Lana Del Rey'] };
  assert.equal(candidateMatchesTitleArtist(games, upload('Video Games (Official Video)', 'Lana Del Rey')), true);
});

test('admitted Spotify and Apple requests survive preparation (stored URLs are re-parsed) and share one recording', async () => {
  const clock = new FakeClock();
  const inner = new FakeSource().add('https://youtu.be/GFOtrack001', { title: 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: 212, recordingKey: 'same-recording' });
  const media = new FakeMedia();
  const svc = new JukeboxService({ dbPath: ':memory:', clock, source: matching(inner), media });
  const admin = { kind: 'user' as const, identity: { key: 'test#admin', issuer: 'test', subject: 'admin', displayName: 'admin', roles: ['organizer'] } };
  const bob = { kind: 'user' as const, identity: { key: 'test#bob', issuer: 'test', subject: 'bob', displayName: 'bob', roles: [] } };
  const alice = { kind: 'user' as const, identity: { key: 'test#alice', issuer: 'test', subject: 'alice', displayName: 'alice', roles: [] } };
  try {
    await run(svc, admin, 'night.open', {});
    assert.ok((await run(svc, alice, 'request.submit', { url: MATCHING_FIXTURE_URLS.apple })).ok);
    await svc.reconcile();
    const entry = svc.snapshot(alice).requests[0]!;
    assert.equal(entry.status, 'ready', entry.error ?? 'not ready');
    assert.equal(entry.sourceUrl, 'https://music.apple.com/song/1000000000001', 'the requested link is what is kept');
    assert.equal(entry.title, 'A New Kind Of Love (pt. 1)');
    const again = await run(svc, bob, 'request.submit', { url: MATCHING_FIXTURE_URLS.spotify });
    assert.equal(!again.ok && again.error.code, 'DUPLICATE_REQUEST', 'same recording via another service');
    assert.equal(svc.snapshot(bob).quota?.used, 0);
  } finally {
    svc.close();
  }
});

test('the offline dev source resolves its demo links and fixture catalog links', async () => {
  const source = fixtureMatchingSource();
  for (const url of [...Object.values(DEMO_YOUTUBE_LINKS), MATCHING_FIXTURE_URLS.spotify, MATCHING_FIXTURE_URLS.apple, MATCHING_FIXTURE_URLS.ambiguous, MATCHING_FIXTURE_URLS.durationTrap]) {
    assert.ok((await source.resolve(source.canonicalize(url), 'request')).durationSec > 0, url);
  }
});

test('candidate is checked again after resolve: changed title/version/artist cannot silently win', async () => {
  for (const changed of [
    {title:'Unrelated song',artist:'Ghost Funk Orchestra'},
    {title:'A New Kind Of Love Pt 1 (Live)',artist:'Ghost Funk Orchestra'},
    {title:'A New Kind Of Love Pt 1',artist:'Other Artist'},
  ]) {
    const source=matching(new FakeSource().add('https://youtu.be/GFOtrack001',{...changed,durationSec:212}));
    await expectMatchError(source,MATCHING_FIXTURE_URLS.spotify,'version_mismatch');
  }
});

test('60-second match tolerance includes its boundary; full catalog duration still guards requests',async()=>{
  assert.equal(durationMatches(152, 212000), true);
  assert.equal(durationMatches(272, 212000), true);
  assert.equal(durationMatches(151.9, 212000), false);
  assert.equal(durationMatches(272.1, 212000), false);
  let searches=0;
  const source=new MatchingSource(new FakeSource(),{lookup:async()=>({provider:'spotify',itemId:'A'.repeat(22),title:'Song',artists:['Artist'],durationMs:360001})},{search:async()=>{searches++;return [];}});
  await assert.rejects(source.resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify),'request'),(e:any)=>e.code==='DURATION_REJECTED');
  assert.equal(searches,0);
});

test('audio-format failure tries one distinct equivalent upload, preserving the selected recording', async () => {
  const candidate = (id: string, channel = 'Ghost Funk Orchestra', title = 'A New Kind Of Love Pt 1', durationSec = 212) => ({
    url: `https://youtu.be/${id}`, title, channel, durationSec,
  });
  const candidates = [
    candidate('FIRSTsong01', 'Ghost Funk Orchestra - Topic'),
    candidate('FIRSTsong01'), // canonical duplicate must not consume the fallback
    candidate('COVERsong01', undefined, 'A New Kind Of Love Pt 1 (Cover)'),
    candidate('WRONGsong01', 'Other Artist'),
    candidate('EDITsong001', undefined, undefined, 273), // beyond the 60-second catalog tolerance
    candidate('SECONDsong1', undefined, undefined, 272),
    candidate('THIRDsong01'),
  ];
  const calls: string[] = [];
  const fake = new FakeSource().add('https://youtu.be/SECONDsong1', { title: 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: 272, recordingKey: 'fallback-recording' });
  const inner: SourcePort = {
    canonicalize: canonicalizeUrl,
    resolve: async (ref, purpose) => {
      calls.push(ref.itemId);
      if (ref.itemId === 'FIRSTsong01') throw new PortError('SOURCE_UNAVAILABLE', 'No audio-only format', true, { kind: 'audio_format_unavailable' });
      return fake.resolve(ref, purpose);
    },
  };
  const source = new MatchingSource(inner, new FixtureCatalog(), { search: async () => candidates });
  const result = await source.resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify), 'request');
  assert.deepEqual(calls, ['FIRSTsong01', 'SECONDsong1']);
  assert.equal(result.recordingKey, 'fallback-recording');
  assert.equal((result.selection as { matchedUrl: string }).matchedUrl, 'https://www.youtube.com/watch?v=SECONDsong1');
  assert.ok(result.match?.reasons.some(reason => reason.includes('used an equivalent matched upload')));
});

test('fallback is bounded, preserves upstream failures, and revalidates resolved metadata', async () => {
  for (const scenario of ['all_formats_fail', 'worker_outage', 'changed_recording', 'overlong_recording'] as const) {
    const calls: string[] = [];
    const source = new MatchingSource({
      canonicalize: canonicalizeUrl,
      resolve: async (ref) => {
        calls.push(ref.itemId);
        if (scenario === 'worker_outage') throw new PortError('SOURCE_UNAVAILABLE', 'Worker offline', true, { kind: 'worker_unavailable' });
        if ((scenario !== 'changed_recording' && scenario !== 'overlong_recording') || calls.length === 1) throw new PortError('SOURCE_UNAVAILABLE', 'YouTube withheld audio-only format', true, { kind: 'audio_format_unavailable', stage: 'candidate_resolution' });
        return { ref, title: scenario === 'changed_recording' ? 'A New Kind Of Love Pt 1 (Live)' : 'A New Kind Of Love Pt 1', artist: 'Ghost Funk Orchestra', durationSec: scenario === 'overlong_recording' ? 360 : 212, recordingKey: ref.itemId, selection: {} };
      },
    }, new FixtureCatalog(), { search: async () => ['FIRSTsong01', 'SECONDsong1', 'THIRDsong01'].map(id => ({
      url: `https://youtu.be/${id}`, title: 'A New Kind Of Love Pt 1', channel: 'Ghost Funk Orchestra', durationSec: 212,
    })) });
    await assert.rejects(source.resolve(canonicalizeUrl(MATCHING_FIXTURE_URLS.spotify), 'request'), (error: unknown) => {
      assert.ok(error instanceof PortError);
      if (scenario === 'overlong_recording') { assert.equal(error.code, 'DURATION_REJECTED'); return true; }
      assert.equal(error.details?.kind, scenario === 'changed_recording' ? 'version_mismatch' : scenario === 'worker_outage' ? 'worker_unavailable' : 'audio_format_unavailable');
      if (scenario === 'all_formats_fail') {
        assert.equal(error.message, 'YouTube withheld audio-only format');
        assert.equal(error.technical, true);
        assert.equal((error.details?.attemptedUrls as string[]).length, 2);
      }
      return true;
    });
    assert.equal(calls.length, scenario === 'worker_outage' ? 1 : 2);
  }
});
