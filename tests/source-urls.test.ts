import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalizeUrl } from '../src/core/sources.ts';
import { harness } from './helpers.ts';
const cases = JSON.parse(readFileSync(new URL('./fixtures/source-urls.json', import.meta.url), 'utf8'));
const canonical = 'https://www.youtube.com/watch?v=yL-4oSQwzJI';
test('real single-video URL forms discard time/navigation and have one idempotent identity', () => {
  for (const url of cases.accepted) {
    const ref = canonicalizeUrl(url);
    assert.equal(ref.canonicalUrl, canonical, url);
    assert.deepEqual(canonicalizeUrl(ref.canonicalUrl), ref);
  }
  assert.ok(cases.accepted.some((url: string) => url.length > 300 && url.length <= 2048));
  assert.throws(() => canonicalizeUrl(canonical + '&pp=' + 'a'.repeat(2048)));
  for (const url of cases.rejected) assert.throws(() => canonicalizeUrl(url), { name: "Error" }, url);
});
test('Apple shared tracks retain non-US storefront and all catalog canonical URLs reparse', () => {
  for (const url of ['https://music.apple.com/gb/album/name/123?i=456&ls=1&app=music', 'https://music.apple.com/us/song/name/456?l=en-US', 'https://open.spotify.com/intl-de/track/1OAFmguvHB2OI2AMYXpmyG?utm_source=copy-link&si=abc']) {
    const ref = canonicalizeUrl(url); assert.deepEqual(canonicalizeUrl(ref.canonicalUrl), ref);
    if (url.includes('/gb/')) assert.equal(ref.canonicalUrl, 'https://music.apple.com/gb/song/456');
  }
});
test('navigation variants share duplicate identity; time does not shorten admission duration or spend quota', async () => {
  const h = harness();
  try {
    await h.startNight();
    h.source.add(canonical, { title: 'Whole long recording', durationSec: 3443 });
    // API URL bound moves to 2048 in the shared owner branch; exercise the
    // long URL directly above and use current <=300 API inputs here.
    for (const url of cases.accepted.filter((value: string) => value.length <= 300)) await h.fails('DURATION_REJECTED', h.alice, 'request.submit', { url });
    assert.equal(h.snap(h.alice).quota?.used, 0);
    h.source.add(canonical, { title: 'Short recording fixture', durationSec: 100 });
    const command = { commandId: crypto.randomUUID(), type: 'request.submit' as const, payload: { url: cases.accepted[0] } };
    assert.equal((await h.svc.execute(h.alice, command)).ok, true);
    const replay = await h.svc.execute(h.alice, command);
    assert.equal(replay.ok && replay.replayed, true);
    await h.fails('DUPLICATE_REQUEST', h.bob, 'request.submit', { url: cases.accepted[1] });
    assert.equal(h.snap(h.alice).quota?.used, 1);
    assert.equal(h.snap(h.bob).quota?.used, 0);
  } finally { h.svc.close(); }
});

test('mobile share links discard tracking while preserving recording identity', () => {
  const links = [
    ['https://open.spotify.com/track/1NkIn479Q5zgQud2tWJsNH?si=P4SaDdgZRzu90BIPZE_MQg&utm_source=copy-link&rowId=2c898f5c0ee003f8', 'https://open.spotify.com/track/1NkIn479Q5zgQud2tWJsNH'],
    ['https://youtu.be/e-ORhEE9VVg?is=aymtwS9tvqxhsx7Z', 'https://www.youtube.com/watch?v=e-ORhEE9VVg'],
    ['https://music.apple.com/us/album/song/123?i=456&ls=1&app=music&at=affiliate&ct=share&itsct=music_box_link&itscg=30200', 'https://music.apple.com/song/456'],
  ];
  for (const [url, canonical] of links) {
    const ref = canonicalizeUrl(url);
    assert.equal(ref.canonicalUrl, canonical);
    assert.deepEqual(canonicalizeUrl(canonical), ref);
  }
  assert.throws(() => canonicalizeUrl(links[0]![0] + '&rowId=duplicate'));
  assert.throws(() => canonicalizeUrl(links[1]![0] + '&is=duplicate'));
});
