// Two attendee browsers plus an organizer over real HTTP/SSE: preview, submit through the
// Spotify matcher, removal, and consistent snapshots. Fake PH ID, fixture catalog, no network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { Snapshot } from '../src/contract/types.ts';
import { FakeClock, FakeIdentity, FakeMedia } from '../src/adapters/fakes.ts';
import { DEMO_YOUTUBE_LINKS, MATCHING_FIXTURE_URLS, fixtureMatchingSource } from '../src/adapters/matching-fixtures.ts';
import { createHttpServer } from '../src/server/http.ts';
import { JukeboxService } from '../src/server/service.ts';

class Browser {
  jar = new Map<string, string>();
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }
  private headers(extra: Record<string, string> = {}) {
    return { ...extra, ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) };
  }
  private async fetch(path: string, init: RequestInit = {}) {
    const res = await fetch(new URL(path, this.base), { ...init, redirect: 'manual', headers: this.headers(init.headers as Record<string, string>) });
    for (const raw of res.headers.getSetCookie()) {
      const [k, v] = raw.split(';')[0]!.split('=');
      if (v) this.jar.set(k!, v);
      else this.jar.delete(k!);
    }
    return res;
  }
  async login(sub: string, organizer = false) {
    const start = await this.fetch('/auth/login?returnTo=/queue');
    const state = new URL(start.headers.get('location')!, this.base).searchParams.get('state');
    const done = await this.fetch(`/auth/callback?state=${state}&sub=${sub}${organizer ? '&roles=organizer' : ''}`);
    assert.equal(done.status, 303);
  }
  async command(type: string, payload: unknown, commandId = randomUUID()) {
    const res = await this.fetch('/api/v1/commands', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return await res.json() as { ok: boolean; replayed: boolean; result?: any; error?: { code: string; details?: Record<string, unknown> } };
  }
  stream() {
    const controller = new AbortController();
    const seen: Snapshot[] = [];
    const waiters: (() => void)[] = [];
    void fetch(new URL('/api/v1/stream', this.base), { headers: this.headers(), signal: controller.signal }).then(async (res) => {
      let buffer = '';
      for await (const chunk of res.body!) {
        buffer += Buffer.from(chunk).toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer.slice(0, index).split('\n').find((l) => l.startsWith('data: '));
          buffer = buffer.slice(index + 2);
          if (data) {
            seen.push(JSON.parse(data.slice(6)));
            waiters.splice(0).forEach((w) => w());
          }
        }
      }
    }).catch(() => undefined);
    return {
      seen,
      async until(predicate: (s: Snapshot) => boolean) {
        for (let i = 0; i < 100; i++) {
          const match = seen.findLast(predicate);
          if (match) return match;
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
            setTimeout(resolve, 50);
          });
        }
        throw new Error('stream condition not reached');
      },
      close: () => controller.abort(),
    };
  }
}

test('two attendees and an organizer share one queue over HTTP; preview is read-only; matching details survive the wire', async () => {
  const clock = new FakeClock();
  const service = new JukeboxService({ dbPath: ':memory:', clock, source: fixtureMatchingSource(), media: new FakeMedia() });
  const server = createHttpServer({ service, identity: new FakeIdentity(), origin: 'http://127.0.0.1' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [admin, alice, bob] = [new Browser(base), new Browser(base), new Browser(base)];
  const streams: { close(): void }[] = [];
  try {
    await Promise.all([admin.login('organizer1', true), alice.login('alice'), bob.login('bob')]);
    assert.equal((await new Browser(base).command('request.preview', { url: DEMO_YOUTUBE_LINKS.song })).error?.code, 'UNAUTHENTICATED');
    assert.equal((await alice.command('request.preview', { url: DEMO_YOUTUBE_LINKS.song })).error?.code, 'NIGHT_CLOSED');
    assert.ok((await admin.command('night.open', {})).ok);
    const [aliceStream, bobStream, adminStream] = [alice.stream(), bob.stream(), admin.stream()];
    streams.push(aliceStream, bobStream, adminStream);
    await aliceStream.until((s) => s.quota?.remaining === 3);

    const revision = service.revision();
    const preview = await alice.command('request.preview', { url: MATCHING_FIXTURE_URLS.spotify });
    assert.ok(preview.ok);
    assert.equal(preview.result.source.title, 'A New Kind Of Love (pt. 1)');
    assert.match(preview.result.match.url, /youtube\.com\/watch\?v=GFOtrack001/);
    assert.equal(service.revision(), revision, 'a preview changes nothing for anyone');

    const ambiguous = await alice.command('request.preview', { url: MATCHING_FIXTURE_URLS.ambiguous });
    assert.equal(ambiguous.error?.code, 'SOURCE_UNAVAILABLE');
    assert.equal(ambiguous.error?.details?.kind, 'ambiguous');
    assert.equal((ambiguous.error?.details?.candidates as unknown[]).length, 2);

    const id = randomUUID();
    const first = await alice.command('request.submit', { url: MATCHING_FIXTURE_URLS.spotify, expectRecordingKey: preview.result.source.recordingKey }, id);
    const retry = await alice.command('request.submit', { url: MATCHING_FIXTURE_URLS.spotify, expectRecordingKey: preview.result.source.recordingKey }, id);
    assert.ok(first.ok && retry.ok);
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.result.quota, { used: 1, limit: 3, remaining: 2 });
    await service.reconcile();

    const seenByAlice = await aliceStream.until((s) => s.requests.some((r) => r.status === 'ready'));
    const seenByBob = await bobStream.until((s) => s.revision >= seenByAlice.revision && s.requests.length === 1);
    const seenByAdmin = await adminStream.until((s) => s.revision >= seenByAlice.revision && s.requests.length === 1);
    const view = (s: Snapshot) => s.requests.map(({ id, title, artist, status }) => ({ id, title, artist, status }));
    assert.deepEqual(view(seenByAlice), view(seenByBob));
    assert.deepEqual(view(seenByAlice), view(seenByAdmin));
    assert.equal(seenByAlice.requests[0]!.mine, true);
    assert.equal(seenByBob.requests[0]!.mine, undefined);
    assert.equal(seenByBob.requests[0]!.sourceUrl, undefined, 'others’ links are not exposed');
    assert.equal(seenByAdmin.requests[0]!.requester, 'alice');
    assert.equal(seenByBob.quota?.used, 0);

    // Same recording by another link/person: rejected as a duplicate at preview verdict and submit.
    const dup = await bob.command('request.preview', { url: MATCHING_FIXTURE_URLS.apple });
    assert.ok(dup.ok);
    assert.equal(dup.result.verdict.code, 'DUPLICATE_REQUEST');
    assert.equal((await bob.command('request.submit', { url: MATCHING_FIXTURE_URLS.apple })).error?.code, 'DUPLICATE_REQUEST');

    // Admin removal: the owner sees the outcome (no refund); other attendees just see it leave the queue.
    assert.ok((await admin.command('request.remove', { entryId: seenByAlice.requests[0]!.id })).ok);
    const removed = await aliceStream.until((s) => s.requests.some((r) => r.status === 'removed'));
    assert.equal(removed.quota?.used, 1, 'not refunded');
    const bobAfter = await bobStream.until((s) => s.revision >= removed.revision);
    assert.equal(bobAfter.requests.length, 0, 'removed entries leave everyone else’s queue; only the owner keeps seeing the outcome');
    for (const s of [aliceStream, bobStream]) {
      const revisions = s.seen.map((x) => x.revision);
      assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), 'streams never go backwards');
    }
  } finally {
    for (const s of streams) s.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    service.close();
  }
});
