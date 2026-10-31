// Two browser-like clients plus a paired player over real HTTP/SSE, then a service restart.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Snapshot } from '../src/contract/types.ts';
import { FakeClock, FakeIdentity, FakeMedia, FakeSource } from '../src/adapters/fakes.ts';
import { createHttpServer } from '../src/server/http.ts';
import { JukeboxService } from '../src/server/service.ts';
import { URLS } from './helpers.ts';

async function start(dir: string, clock: FakeClock, source: FakeSource, media: FakeMedia) {
  const service = new JukeboxService({ dbPath: join(dir, 'state.sqlite3'), clock, source, media });
  const server = createHttpServer({ service, identity: new FakeIdentity(), origin: 'http://127.0.0.1' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    service, base,
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      service.close();
    },
  };
}

class Client {
  jar = new Map<string, string>();
  bearer: string | null = null;
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (this.bearer) headers.set('authorization', `Bearer ${this.bearer}`);
    const res = await fetch(new URL(path, this.base), { ...init, headers, redirect: 'manual' });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [k, v] = pair!.split('=');
      if (v) this.jar.set(k!, v);
      else this.jar.delete(k!);
    }
    return res;
  }
  async login(sub: string, organizer = false) {
    const login = await this.fetch('/auth/login?returnTo=/queue');
    const fake = new URL(login.headers.get('location')!, this.base);
    const callback = await this.fetch(`/auth/callback?state=${fake.searchParams.get('state')}&sub=${sub}${organizer ? '&roles=organizer' : ''}`);
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/queue');
  }
  async command(type: string, payload: unknown, commandId = randomUUID()) {
    const res = await this.fetch('/api/v1/commands', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
      body: JSON.stringify({ commandId, type, payload }),
    });
    return { status: res.status, body: await res.json() as { ok: boolean; result?: Record<string, unknown>; error?: { code: string }; revision?: number } };
  }
  async snapshot() {
    return await (await this.fetch('/api/v1/snapshot')).json() as Snapshot;
  }
  /** Minimal SSE reader keeping every snapshot received. */
  stream() {
    const controller = new AbortController();
    const seen: Snapshot[] = [];
    const waiters: (() => void)[] = [];
    const headers: Record<string, string> = {};
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    void fetch(new URL('/api/v1/stream', this.base), { headers, signal: controller.signal }).then(async (res) => {
      let buffer = '';
      for await (const chunk of res.body!) {
        buffer += Buffer.from(chunk).toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
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
          const match = seen.find(predicate);
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

test('admin, attendee, and paired player share one durable state over HTTP; restart restores it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jukebox-http-'));
  const clock = new FakeClock();
  const source = new FakeSource().add(URLS.mix, { title: 'Hour Mix', durationSec: 3600 }).add(URLS.r1, { title: 'Request One', durationSec: 180 });
  const media = new FakeMedia();
  let app = await start(dir, clock, source, media);
  const admin = new Client(app.base);
  const attendee = new Client(app.base);
  const display = new Client(app.base);
  await admin.login('organizer1', true);
  await attendee.login('alice');
  assert.equal((await (await admin.fetch('/auth/me')).json()).role, 'admin');
  assert.equal((await (await attendee.fetch('/auth/me')).json()).role, 'attendee');

  // Role checks and CSRF on the real transport.
  assert.equal((await attendee.command('night.open', {})).status, 403);
  const csrf = await admin.fetch('/api/v1/commands', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ commandId: randomUUID(), type: 'night.open', payload: {} }),
  });
  assert.equal(csrf.status, 403);
  const form = await admin.fetch('/api/v1/commands', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 403);

  assert.ok((await admin.command('night.open', {})).body.ok);
  assert.ok((await admin.command('master.add', { url: URLS.mix })).body.ok);
  await app.service.reconcile();

  // Display pairs with an admin-issued code; public rendering alone has no authority.
  const publicClaim = await display.command('player.claim', {});
  assert.equal(publicClaim.status, 401);
  const { code } = (await admin.command('device.pairing.create', { name: 'Wall Firefox' })).body.result as { code: string };
  const paired = (await display.command('device.pair', { code })).body.result as { token: string };
  display.bearer = paired.token;
  const claim = (await display.command('player.claim', {})).body.result as { generation: number };

  const attendeeStream = attendee.stream();
  const adminStream = admin.stream();
  await attendeeStream.until(() => true);
  assert.ok((await admin.command('playback.play', {})).body.ok);
  const desired = (await display.snapshot()).desired!;
  assert.equal(desired.asset.url.startsWith('/media/'), true);
  assert.ok((await display.command('player.report', { generation: claim.generation, epoch: desired.epoch, loadId: desired.loadId, status: 'playing', positionSec: 0 })).body.ok);
  const submitted = await attendee.command('request.submit', { url: URLS.r1 });
  assert.ok(submitted.body.ok);
  await app.service.reconcile();

  const seenByAttendee = await attendeeStream.until((s) => s.requests.some((r) => r.status === 'ready'));
  const seenByAdmin = await adminStream.until((s) => s.revision >= seenByAttendee.revision && s.requests.some((r) => r.status === 'ready'));
  assert.equal(seenByAttendee.requests[0]!.mine, true);
  assert.equal(seenByAttendee.requests[0]!.requester, undefined);
  assert.equal(seenByAdmin.requests[0]!.requester, 'alice');
  assert.equal(seenByAdmin.playback.confirmation, 'confirmed');
  const revisions = attendeeStream.seen.map((s) => s.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), 'stream never goes backwards');
  attendeeStream.close();
  adminStream.close();

  // Restart: same data, new process objects; sessions, device token, queue, and checkpoint survive.
  const before = await admin.snapshot();
  await app.stop();
  app = await start(dir, clock, source, media);
  for (const client of [admin, attendee, display]) client.base = app.base;
  const after = await admin.snapshot();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.requests, before.requests);
  assert.equal((await attendee.snapshot()).quota?.used, 1);
  const again = await display.command('player.report', { generation: claim.generation, epoch: desired.epoch, loadId: desired.loadId, status: 'playing', positionSec: 5 });
  assert.ok(again.body.ok, 'lease survives a quick service restart');
  // Revoked device tokens are rejected at the transport.
  const deviceId = paired.token.split('.')[0]!;
  assert.ok((await admin.command('device.revoke', { deviceId })).body.ok);
  assert.equal((await display.fetch('/api/v1/snapshot')).status, 401);
  await app.stop();
});
