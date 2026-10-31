// Phase 4A test harness: the real HTTP service (fake clock/adapters), cookie-jar browser stand-ins,
// and a scripted fake display that talks only HTTP. No browser, no network beyond loopback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandPayloads, CommandResponse, CommandType, ObservedStatus, Policy, Snapshot } from '../src/contract/types.ts';
import { FakeClock, FakeIdentity, FakeMedia, FakeSource } from '../src/adapters/fakes.ts';
import { createHttpServer } from '../src/server/http.ts';
import { JukeboxService } from '../src/server/service.ts';
import type { Send } from '../app/src/admin/intents.ts';
import { URLS } from './helpers.ts';

export const ORIGIN = 'http://127.0.0.1';
// Captured at load so tests may replace globalThis.fetch (browser stand-in) without recursion.
const realFetch = globalThis.fetch;

export async function startApp(policy: Partial<Policy> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jukebox-admin-'));
  const clock = new FakeClock();
  const source = new FakeSource()
    .add(URLS.mix, { title: 'Hour Mix', durationSec: 3600 })
    .add(URLS.mix2, { title: 'Second Mix', durationSec: 2400 })
    .add(URLS.song, { title: 'Master Song', durationSec: 200 })
    .add(URLS.r1, { title: 'Request One', durationSec: 180 })
    .add(URLS.r2, { title: 'Request Two', durationSec: 200 })
    .add(URLS.r3, { title: 'Request Three', durationSec: 150 });
  const media = new FakeMedia();
  const service = new JukeboxService({ dbPath: join(dir, 'state.sqlite3'), clock, source, media, policy });
  const server = createHttpServer({ service, identity: new FakeIdentity(), origin: ORIGIN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    service, clock, media, source, base,
    client: () => new HttpClient(base),
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      service.close();
    },
  };
}

export type App = Awaited<ReturnType<typeof startApp>>;

/** What a browser tab is: a cookie jar (or a device bearer) pointed at the service. */
export class HttpClient {
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
    const res = await realFetch(new URL(path, this.base), { ...init, headers, redirect: 'manual' });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [k, v] = pair!.split('=');
      if (v) this.jar.set(k!, v);
      else this.jar.delete(k!);
    }
    return res;
  }
  async login(sub: string, organizer = false) {
    const login = await this.fetch('/auth/login?returnTo=/admin');
    const fake = new URL(login.headers.get('location')!, this.base);
    const callback = await this.fetch(`/auth/callback?state=${fake.searchParams.get('state')}&sub=${sub}${organizer ? '&roles=organizer' : ''}`);
    assert.equal(callback.status, 303);
    return this;
  }
  async raw<T extends CommandType>(type: T, payload: CommandPayloads[T], commandId: string = randomUUID(), expectedRevision?: number) {
    const res = await this.fetch('/api/v1/commands', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ commandId, type, payload, expectedRevision }),
    });
    return { status: res.status, body: await res.json() as CommandResponse<T> };
  }
  /** The `Send` the admin CommandRunner uses, over real HTTP (same envelope as shared/api.ts). */
  send: Send = async (type, payload, options) => (await this.raw(type, payload, options.commandId, options.expectedRevision)).body;
  async snapshot() {
    return await (await this.fetch('/api/v1/snapshot')).json() as Snapshot;
  }
}

export async function organizer(app: App, sub = 'organizer1') {
  return await app.client().login(sub, true);
}

/** A paired display driven by the test: claims the lease and reports like the phase-3 player would. */
export class ScriptedDisplay {
  readonly client: HttpClient;
  generation = 0;
  position = 0;
  loadId = -1;
  seekSeq = -1;
  private constructor(client: HttpClient) {
    this.client = client;
  }
  static async pair(app: App, admin: HttpClient, name = 'Wall Firefox') {
    const created = await admin.raw('device.pairing.create', { name });
    assert.ok(created.body.ok);
    const code = (created.body as { result: { code: string } }).result.code;
    const display = new ScriptedDisplay(app.client());
    const paired = await display.client.raw('device.pair', { code });
    assert.ok(paired.body.ok);
    display.client.bearer = (paired.body as { result: { token: string } }).result.token;
    const claim = await display.client.raw('player.claim', {});
    assert.ok(claim.body.ok);
    display.generation = (claim.body as { result: { generation: number } }).result.generation;
    return display;
  }
  async desired() {
    return (await this.client.snapshot()).desired ?? null;
  }
  /** Acknowledge the latest desired state with an observed status (a fresh report renews the lease). */
  async report(status: ObservedStatus = 'playing', positionSec?: number) {
    const desired = await this.desired();
    assert.ok(desired, 'display has nothing to report');
    if (desired.loadId !== this.loadId || desired.seekSeq !== this.seekSeq) {
      this.loadId = desired.loadId;
      this.seekSeq = desired.seekSeq;
      this.position = desired.startPositionSec;
    }
    if (positionSec !== undefined) this.position = positionSec;
    const res = await this.client.raw('player.report', { generation: this.generation, epoch: desired.epoch, loadId: desired.loadId, status, positionSec: this.position });
    assert.ok(res.body.ok, JSON.stringify(res.body));
    return desired;
  }
}

/** Open a night, add masters, pair a display, press play, and confirm it. */
export async function startNight(app: App, admin: HttpClient, masters: string[] = [URLS.mix], options: { nightOpen?: boolean } = {}) {
  if (!options.nightOpen) assert.ok((await admin.raw('night.open', {})).body.ok);
  for (const url of masters) assert.ok((await admin.raw('master.add', { url })).body.ok);
  await app.service.reconcile();
  const display = await ScriptedDisplay.pair(app, admin);
  assert.ok((await admin.raw('playback.play', {})).body.ok);
  await display.report('playing', 0);
  return display;
}
