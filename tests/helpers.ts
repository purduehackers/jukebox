import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandPayloads, CommandResponse, CommandResult, CommandType, ObservedStatus, Policy, Snapshot } from '../src/contract/types.ts';
import { FakeClock, FakeMedia, FakeSource } from '../src/adapters/fakes.ts';
import type { Actor } from '../src/server/service.ts';
import { JukeboxService } from '../src/server/service.ts';

export const MIN = 60_000;
export const URLS = {
  mix: 'https://youtu.be/MIXmixmix01',
  mix2: 'https://youtu.be/MIXmixmix02',
  song: 'https://youtu.be/SONGsong001',
  boundary: 'https://youtu.be/SONGsong360',
  justMix: 'https://youtu.be/MIXmixmx361',
  r1: 'https://youtu.be/REQreqreq01',
  r2: 'https://youtu.be/REQreqreq02',
  r3: 'https://youtu.be/REQreqreq03',
  r4: 'https://youtu.be/REQreqreq04',
  long: 'https://youtu.be/REQreqrq360',
  almost: 'https://youtu.be/REQreqrq359',
  r1Alt: 'https://www.youtube.com/watch?v=REQreqreq01&si=share123',
  sameRecording: 'https://youtu.be/REQsamerec1',
  spotify: 'https://open.spotify.com/track/1OAFmguvHB2OI2AMYXpmyG',
};

export function user(subject: string, roles: string[] = []): Actor {
  return { kind: 'user', identity: { key: `test#${subject}`, issuer: 'test', subject, displayName: subject, username: subject, roles } };
}

export function harness(policy: Partial<Policy> = {}, dir = mkdtempSync(join(tmpdir(), 'jukebox-test-'))) {
  const clock = new FakeClock();
  const source = new FakeSource()
    .add(URLS.mix, { title: 'Hour Mix', durationSec: 3600 })
    .add(URLS.mix2, { title: 'Second Mix', durationSec: 2400 })
    .add(URLS.song, { title: 'Master Song', durationSec: 200 })
    .add(URLS.boundary, { title: 'Exactly Six', durationSec: 360 })
    .add(URLS.justMix, { title: 'Six Plus', durationSec: 361 })
    .add(URLS.r1, { title: 'Request One', durationSec: 180 })
    .add(URLS.r2, { title: 'Request Two', durationSec: 200 })
    .add(URLS.r3, { title: 'Request Three', durationSec: 150 })
    .add(URLS.r4, { title: 'Request Four', durationSec: 120 })
    .add(URLS.long, { title: 'Too Long', durationSec: 360 })
    .add(URLS.almost, { title: 'Almost Six', durationSec: 359.999 })
    .add(URLS.sameRecording, { title: 'Same As One', durationSec: 180, recordingKey: 'youtube:REQreqreq01' });
  const media = new FakeMedia();
  const dbPath = join(dir, 'state.sqlite3');
  const make = () => new JukeboxService({ dbPath, clock, source, media, policy });
  const h = {
    dir, clock, source, media, svc: make(),
    admin: user('organizer1', ['organizer']),
    admin2: user('organizer2', ['admin', 'organizer']),
    alice: user('alice'),
    bob: user('bob'),
    restart(): void {
      h.svc.close();
      h.svc = make();
    },
    async cmd<T extends CommandType>(actor: Actor, type: T, payload: CommandPayloads[T], extra: { commandId?: string; expectedRevision?: number } = {}): Promise<CommandResponse<T>> {
      return h.svc.execute(actor, { commandId: extra.commandId ?? randomUUID(), type, payload, expectedRevision: extra.expectedRevision }) as Promise<CommandResponse<T>>;
    },
    async ok<T extends CommandType>(actor: Actor, type: T, payload: CommandPayloads[T], extra: { commandId?: string } = {}): Promise<CommandResult<T>> {
      const response = await h.cmd(actor, type, payload, extra);
      assert.ok(response.ok, `${type} failed: ${JSON.stringify(response)}`);
      return response.result as CommandResult<T>;
    },
    async fails(code: string, actor: Actor, type: CommandType, payload: unknown): Promise<CommandResponse> {
      const response = await h.cmd(actor, type, payload as never);
      assert.equal(response.ok, false, `${type} unexpectedly succeeded`);
      if (!response.ok) assert.equal(response.error.code, code, response.error.message);
      return response;
    },
    snap(actor?: Actor): Snapshot {
      return h.svc.snapshot(actor ?? h.admin);
    },
    /** Advance the fake clock; a given player heartbeats every 5s like a real one (never auto-ends). */
    async advance(ms: number, p?: Player): Promise<void> {
      if (!p) {
        h.clock.advance(ms);
        await h.svc.reconcile();
        return;
      }
      let left = ms;
      while (left > 0) {
        const step = Math.min(5000, left);
        left -= step;
        h.clock.advance(step);
        await p.heartbeat(step);
        await h.svc.reconcile();
      }
    },
    async pairPlayer(name = 'Wall Firefox'): Promise<Player> {
      const { code } = await h.ok(h.admin, 'device.pairing.create', { name });
      const { deviceId } = await h.ok({ kind: 'public' }, 'device.pair', { code });
      return player(h, deviceId);
    },
    /** Open a night, add master items, play, and attach a paired, reporting player. */
    async startNight(masters: string[] = [URLS.mix]): Promise<Player> {
      await h.ok(h.admin, 'night.open', {});
      for (const url of masters) await h.ok(h.admin, 'master.add', { url });
      await h.svc.reconcile();
      const p = await h.pairPlayer();
      await p.claim();
      await h.ok(h.admin, 'playback.play', {});
      await p.sync('playing', 0);
      return p;
    },
  };
  return h;
}

export type Harness = ReturnType<typeof harness>;
interface PlayerHost {
  svc: JukeboxService;
  ok<T extends CommandType>(actor: Actor, type: T, payload: CommandPayloads[T]): Promise<CommandResult<T>>;
}

export type Player = ReturnType<typeof player>;

export function player(h: PlayerHost, deviceId: string) {
  const actor: Actor = { kind: 'device', deviceId };
  const p = {
    actor,
    deviceId,
    generation: 0,
    loadId: -1,
    position: 0,
    async claim(takeover = false) {
      const result = await h.ok(actor, 'player.claim', { takeover });
      p.generation = result.generation;
      return result;
    },
    desired() {
      return h.svc.snapshot(actor).desired ?? null;
    },
    /** Report the current desired load/epoch with an observed status. */
    async sync(status: ObservedStatus, positionSec: number, previous?: { loadId: number; positionSec: number }) {
      const d = p.desired();
      assert.ok(d, 'player has no desired playback');
      p.loadId = d.loadId;
      p.position = positionSec;
      return h.svc.execute(actor, {
        commandId: randomUUID(), type: 'player.report',
        payload: { generation: p.generation, epoch: d.epoch, loadId: d.loadId, status, positionSec, ...(previous ? { previous } : {}) },
      });
    },
    /** Follow desired state: new load → start position; playing advances position. */
    async heartbeat(stepMs: number) {
      const d = p.desired();
      if (!d) return;
      if (d.loadId !== p.loadId) {
        p.loadId = d.loadId;
        p.position = d.startPositionSec;
      } else if (d.intent === 'playing') {
        p.position = Math.min(p.position + stepMs / 1000, d.asset.durationSec - 0.001);
      }
      const response = await p.sync(d.intent === 'playing' ? 'playing' : 'paused', p.position);
      assert.ok(response.ok, JSON.stringify(response));
    },
    async report(payload: CommandPayloads['player.report']) {
      return h.svc.execute(actor, { commandId: randomUUID(), type: 'player.report', payload });
    },
  };
  return p;
}

export async function submit(h: Harness, who: Actor, url: string) {
  const response = await h.cmd(who, 'request.submit', { url });
  await h.svc.reconcile();
  return response;
}
