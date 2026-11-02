import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveCatalog } from '../src/adapters/live-catalog.ts';
import { canonicalizeUrl } from '../src/core/sources.ts';
import { PortError } from '../src/core/ports.ts';
const spotify = canonicalizeUrl('https://open.spotify.com/track/1OAFmguvHB2OI2AMYXpmyG');
const apple = canonicalizeUrl('https://music.apple.com/gb/song/title/123');
const entity = { type: 'track', id: spotify.itemId, uri: `spotify:track:${spotify.itemId}`, name: 'Song (Live)', artists: [{ name: 'Artist' }], duration: 180001, audioPreview: { url: 'https://must-not-fetch.invalid/audio' } };
function embed(e: any = entity) { return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: e }, settings: { session: { accessToken: 'must-not-retain' } } } } } })}</script>`; }
const fake = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>) => ((url: any, init?: RequestInit) => Promise.resolve(fn(String(url), init))) as typeof fetch;

test('public Spotify metadata uses exact ID/full duration, excludes playback/session data, caches bounded work', async () => {
  let calls = 0;
  const catalog = new LiveCatalog({ fetch: fake((url, init) => {
    calls++; assert.equal(url, `https://open.spotify.com/embed/track/${spotify.itemId}`);
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); return new Response(embed());
  }) });
  const first = await catalog.lookup(spotify);
  assert.equal(first?.durationMs, 180001); assert.equal(first?.provenance, 'spotify_public_embed');
  assert.equal(JSON.stringify(first).includes('must-not'), false);
  first!.artists.push('Mutation');
  assert.deepEqual((await catalog.lookup(spotify))?.artists, ['Artist']); assert.equal(calls, 1);
});
test('changed/incomplete Spotify embed fails closed, never follows a preview or invents duration', async () => {
  for (const body of [embed({ ...entity, id: 'other' }), embed({ ...entity, duration: undefined }), '<html>changed markup</html>', embed({ ...entity, artists: [] })]) {
    await assert.rejects(new LiveCatalog({ fetch: fake(() => new Response(body)) }).lookup(spotify), PortError);
  }
});
test('documented Spotify API client credentials cache tokens, exact ID, auth failures do not fall back', async () => {
  const seen: string[] = [];
  const catalog = new LiveCatalog({ spotifyClientId: 'test-id', spotifyClientSecret: 'test-secret', fetch: fake((url, init) => {
    seen.push(url);
    if (url.endsWith('/api/token')) {
      assert.equal(init?.method, 'POST'); assert.equal(init.body, 'grant_type=client_credentials');
      assert.equal((init?.headers as any).authorization, `Basic ${Buffer.from('test-id:test-secret').toString('base64')}`);
      return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    }
    assert.equal((init?.headers as any).authorization, 'Bearer fixture-token');
    return Response.json({ id: url.split('/').at(-1), name: 'Song', artists: [{ name: 'Artist' }], duration_ms: 180001, external_ids: { isrc: 'TESTISRC' } });
  }) });
  assert.equal((await catalog.lookup(spotify))?.provenance, 'spotify_web_api');
  await catalog.lookup(canonicalizeUrl('https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA'));
  assert.equal(seen.filter(u => u.includes('/api/token')).length, 1);
  const partial = new LiveCatalog({ spotifyClientId: 'id', fetch: fake(() => { throw Error('must not fetch'); }) });
  await assert.rejects(partial.lookup(spotify), (e: any) => e.details.kind === 'catalog_configuration');
  const denied = new LiveCatalog({ spotifyClientId: 'id', spotifyClientSecret: 'secret', fetch: fake(() => new Response('', { status: 401 })) });
  await assert.rejects(denied.lookup(spotify), (e: any) => e.details.kind === 'catalog_configuration');
});
test('Apple lookup uses requested storefront and exact song ID, never selects album or preview', async () => {
  const catalog = new LiveCatalog({ fetch: fake(url => {
    assert.equal(url, 'https://itunes.apple.com/lookup?id=123&entity=song&country=gb&limit=1');
    return Response.json({ results: [{ kind: 'song', trackId: 999, trackName: 'Wrong' }, { kind: 'song', trackId: 123, trackName: 'Title', artistName: 'Artist', trackTimeMillis: 180000, previewUrl: 'https://must-not-fetch.invalid' }] });
  }) });
  assert.equal((await catalog.lookup(apple))?.title, 'Title');
  assert.equal((await catalog.lookup(apple))?.provenance, 'apple_itunes_lookup');
  await assert.rejects(new LiveCatalog({ fetch: fake(() => Response.json({ results: [{ kind: 'album', collectionId: 123 }] })) }).lookup(apple), (e: any) => e.details.kind === 'catalog_metadata');
});
test('provider errors and body bounds are safe, retryable when operational, redirect disabled', async () => {
  for (const status of [429, 500, 302]) await assert.rejects(new LiveCatalog({ fetch: fake(() => new Response('secret', { status })) }).lookup(apple), (e: any) => !e.message.includes('secret') && e.technical);
  await assert.rejects(new LiveCatalog({ fetch: fake(() => { throw Error('secret'); }) }).lookup(apple), (e: any) => !e.message.includes('secret') && e.technical);
  await assert.rejects(new LiveCatalog({ fetch: fake(() => new Response('x'.repeat(2 * 1024 * 1024 + 1))) }).lookup(apple), PortError);
  await assert.rejects(new LiveCatalog().lookup({ ...spotify, itemId: '../../etc' }), (e: any) => e.code === 'INVALID_SOURCE');
});
test('catalog concurrency is bounded independently of attendee rate limits', async () => {
  let release!: () => void;
  const pending = new Promise<void>(r => release = r);
  const catalog = new LiveCatalog({ fetch: fake(async () => { await pending; return new Response(embed()); }) });
  const a = catalog.lookup(spotify), b = catalog.lookup(spotify);
  await assert.rejects(catalog.lookup(spotify), (e: any) => e.technical);
  release(); await Promise.all([a, b]);
});

test('optional Apple Music API uses exact storefront/song and full metadata, with no preview fallback',async()=>{
  const catalog=new LiveCatalog({appleDeveloperToken:'fixture-developer-token',fetch:fake((url,init)=>{
    assert.equal(url,'https://api.music.apple.com/v1/catalog/gb/songs/123');
    assert.equal((init?.headers as any).authorization,'Bearer fixture-developer-token');
    return Response.json({data:[{id:'123',type:'songs',attributes:{name:'Song',artistName:'Artist',durationInMillis:222333,isrc:'TESTISRC',previews:[{url:'must-not-fetch'}]}}]});
  })});
  const value=await catalog.lookup(apple);assert.equal(value?.durationMs,222333);assert.equal(value?.provenance,'apple_music_api');assert.equal(JSON.stringify(value).includes('fixture-developer-token'),false);
  await assert.rejects(new LiveCatalog({appleDeveloperToken:'fixture',fetch:fake(()=>Response.json({data:[{id:'456',type:'songs',attributes:{name:'Other'}}]}))}).lookup(apple),PortError);
});

test('upstream catalog request budget is global and bounded even for distinct missing tracks',async()=>{
  let calls=0;
  const catalog=new LiveCatalog({fetch:fake(()=>{calls++;return Response.json({results:[]});})});
  for(let id=1;id<=20;id++) await assert.rejects(catalog.lookup(canonicalizeUrl(`https://music.apple.com/song/${id}`)),PortError);
  await assert.rejects(catalog.lookup(canonicalizeUrl('https://music.apple.com/song/21')),(e:any)=>e.technical && /limit reached/.test(e.message));
  assert.equal(calls,20);
});
