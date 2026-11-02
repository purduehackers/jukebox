// Authoritative queue, scheduler, quota, and device-authority service.
// All state changes run in one SQLite `begin immediate` transaction; async work
// (source resolution, preparation, cache retention) happens outside transactions
// and is re-validated when its result is applied.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Alert, ApiError, MasterStatus, PreviewResult, AssetDescriptor, CommandEnvelope, CommandPayloads, CommandResponse, CommandType, DesiredPlayback,
  ErrorCode, EventRecord, RequestStatus, Identity, MediaPurpose, ObservedPlayback, Phase, PlayerReport, Policy, ResolvedSource,
  QueueMode, Role, Snapshot,
} from '../contract/types.ts';
import { CONTRACT_VERSION, POLICY } from '../contract/types.ts';
import { COMMAND_ROLES, ValidationError, parseEnvelope } from '../contract/validate.ts';
import type { Clock, JobState, MediaPort, SourcePort } from '../core/ports.ts';
import { PortError } from '../core/ports.ts';
import { canonicalizeUrl } from '../core/sources.ts';
import { openDatabase } from './db.ts';

function isHttpArtworkUrl(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password; }
  catch { return false; }
}

export type Actor =
  | { kind: 'public' }
  | { kind: 'user'; identity: Identity }
  | { kind: 'device'; deviceId: string };

export interface ServiceOptions {
  dbPath: string;
  clock: Clock;
  source: SourcePort;
  media: MediaPort;
  policy?: Partial<Policy>;
  /** Identity keys granted admin regardless of PH ID roles (e.g. `issuer#sub`). */
  adminKeys?: string[];
  /** PH ID role names that grant Jukebox admin. Default organizer/admin. */
  adminRoles?: string[];
  /** `request.preview` resolves links (bounded, possibly slow), so it is rate limited per identity. */
  previewLimit?: { max: number; windowMs: number };
}

export class CommandError extends Error {
  code: ErrorCode;
  retryable: boolean;
  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

interface MasterRow {
  id: string; order_key: number; source_url: string; provider: string; title: string; artist: string | null;
  artwork_url: string | null; duration_sec: number; recording_key: string; selection: string; status: string; job_id: string | null;
  asset: string | null; prep_attempts: number; failures: number; error: string | null; removed: number; created_at: number;
}
interface RequestRow {
  id: string; night_id: string; requester_key: string; requester_name: string; order_key: number; source_url: string;
  provider: string; title: string; artist: string | null; duration_sec: number; recording_key: string; selection: string;
  artwork_url: string | null;
  status: string; job_id: string | null; asset: string | null; prep_attempts: number; play_attempts: number;
  charged: number; refunded: number; error: string | null; created_at: number; finished_at: number | null;
}
interface PlaybackRow {
  phase: Phase; intent: 'playing' | 'paused'; period_started_at: number | null; current_id: string | null;
  master_cursor: string | null; master_position: number; suspended: string | null; epoch: number; load_id: number;
  start_position: number; seek_seq: number; seek_epoch: number; volume: number; desired_at: number; generation: number;
  lease_device: string | null; lease_expires: number; observed: string | null; acked_epoch: number | null;
  unconfirmed_noted: number; no_master: number; autostart: number; mode: QueueMode; period_ms: number | null;
}
interface Suspended { itemId: string; positionSec: number; loadId: number }
interface NightRow { id: string; status: 'open' | 'closed'; opened_at: number; closed_at: number | null }

/** Per-transaction context: mutable playback row plus pending events. */
interface Tx {
  now: number;
  pb: PlaybackRow;
  events: { type: string; data: Record<string, unknown> }[];
  /** Force a revision bump even without events (e.g. observed status). */
  touched: boolean;
}

const UNSTORED: CommandType[] = ['player.report', 'device.pair', 'display.connect', 'request.preview'];
const NOT_REPLAYED: ErrorCode[] = ['REVISION_CONFLICT', 'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL', 'IDEMPOTENCY_MISMATCH'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class JukeboxService {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly source: SourcePort;
  readonly media: MediaPort;
  readonly policy: Policy;
  private adminKeys: Set<string>;
  private adminRoles: Set<string>;
  private inflight = new Map<string, Promise<unknown>>();
  private preparing = new Set<string>();
  private listeners = new Set<(revision: number) => void>();
  private retained: string | null = null;
  private reconciling: Promise<void> | null = null;
  private previewLimit: { max: number; windowMs: number };
  private previewTimes = new Map<string, number[]>();

  private lockPath: string | null;

  constructor(options: ServiceOptions) {
    this.lockPath = options.dbPath === ':memory:' ? null : `${options.dbPath}.lock`;
    if (this.lockPath) acquireLock(this.lockPath);
    try {
      this.db = openDatabase(options.dbPath);
    } catch (error) {
      if (this.lockPath) unlinkSync(this.lockPath);
      throw error;
    }
    this.clock = options.clock;
    this.source = options.source;
    this.media = options.media;
    this.policy = { ...POLICY, ...options.policy };
    this.adminKeys = new Set(options.adminKeys ?? []);
    this.adminRoles = new Set(options.adminRoles ?? ['organizer', 'admin']);
    this.previewLimit = options.previewLimit ?? { max: 12, windowMs: 60_000 };
  }

  close() {
    this.db.close();
    if (this.lockPath) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        // already gone
      }
      this.lockPath = null;
    }
  }

  onChange(listener: (revision: number) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isAdmin(identity: Identity) {
    return this.adminKeys.has(identity.key) || identity.roles.some((r) => this.adminRoles.has(r));
  }

  roleOf(actor: Actor): Role {
    if (actor.kind === 'device') return 'player';
    if (actor.kind === 'user') return this.isAdmin(actor.identity) ? 'admin' : 'attendee';
    return 'public';
  }

  revision(): number {
    return Number((this.db.prepare("select value from meta where key = 'revision'").get() as { value: string }).value);
  }

  // ---------------------------------------------------------------- commands

  async execute(actor: Actor, body: unknown): Promise<CommandResponse> {
    let envelope: CommandEnvelope;
    try {
      envelope = parseEnvelope(body);
    } catch (error) {
      const commandId = typeof (body as { commandId?: unknown })?.commandId === 'string' ? (body as { commandId: string }).commandId : null;
      return { ok: false, commandId, replayed: false, error: { code: 'BAD_REQUEST', message: (error as Error).message, retryable: false } };
    }
    // Serialize retries of one commandId that arrive while the first is still resolving.
    const previous = this.inflight.get(envelope.commandId);
    if (previous) await previous.catch(() => undefined);
    const run = this.executeOnce(actor, envelope);
    this.inflight.set(envelope.commandId, run);
    try {
      return await run;
    } finally {
      if (this.inflight.get(envelope.commandId) === run) this.inflight.delete(envelope.commandId);
    }
  }

  private actorKey(actor: Actor) {
    return actor.kind === 'user' ? `user:${actor.identity.key}` : actor.kind === 'device' ? `device:${actor.deviceId}` : 'public';
  }

  private async executeOnce(actor: Actor, envelope: CommandEnvelope): Promise<CommandResponse> {
    const { commandId, type } = envelope;
    const actorKey = this.actorKey(actor);
    const payloadHash = hash(JSON.stringify([type, envelope.expectedRevision ?? null, envelope.payload]));
    const stored = this.db.prepare('select actor, payload_hash, response from commands where id = ?').get(commandId) as
      { actor: string; payload_hash: string; response: string } | undefined;
    if (stored) {
      if (stored.actor !== actorKey || stored.payload_hash !== payloadHash) {
        return this.failure(commandId, new CommandError('IDEMPOTENCY_MISMATCH', 'This commandId was already used for a different command'));
      }
      return { ...(JSON.parse(stored.response) as CommandResponse), replayed: true };
    }
    let response: CommandResponse;
    try {
      this.authorize(actor, type);
      if (type === 'request.preview') return await this.preview(actor, envelope);
      const prepared = await this.precheck(actor, envelope);
      response = this.transaction((tx) => {
        if (envelope.expectedRevision !== undefined && envelope.expectedRevision !== this.revision()) {
          throw new CommandError('REVISION_CONFLICT', 'State changed; refresh and retry with a new decision');
        }
        const result = this.apply(tx, actor, envelope, prepared);
        this.schedule(tx);
        return result;
      }, (result, revision) => {
        const ok: CommandResponse = { ok: true, commandId, revision, result: result as never, replayed: false };
        if (!UNSTORED.includes(type)) this.storeCommand(commandId, actorKey, type, payloadHash, ok);
        return ok;
      });
    } catch (error) {
      response = this.failure(commandId, error);
      if (!response.ok && !UNSTORED.includes(type) && !response.error.retryable && !NOT_REPLAYED.includes(response.error.code)) {
        this.storeCommand(commandId, actorKey, type, payloadHash, response);
      }
    }
    if (response.ok && type !== 'player.report') void this.reconcile();
    return response;
  }

  private storeCommand(id: string, actor: string, type: string, payloadHash: string, response: CommandResponse) {
    this.db.prepare('insert or ignore into commands values(?, ?, ?, ?, ?, ?)')
      .run(id, actor, type, payloadHash, JSON.stringify(response), this.clock.now());
  }

  private failure(commandId: string | null, error: unknown): CommandResponse {
    let api: ApiError;
    if (error instanceof CommandError) api = { code: error.code, message: error.message, retryable: error.retryable };
    else if (error instanceof PortError) api = { code: error.code, message: error.message, retryable: error.technical, ...(error.details ? { details: error.details } : {}) };
    else if (error instanceof ValidationError) api = { code: 'BAD_REQUEST', message: error.message, retryable: false };
    else {
      console.error('[jukebox] internal error', error);
      api = { code: 'INTERNAL', message: 'Internal error', retryable: true };
    }
    return { ok: false, commandId, replayed: false, error: api };
  }

  private authorize(actor: Actor, type: CommandType) {
    const needed = COMMAND_ROLES[type];
    const role = this.roleOf(actor);
    if (needed === 'public') return;
    if (role === 'public') throw new CommandError('UNAUTHENTICATED', needed === 'player' ? 'Pair this device first' : 'Sign in with Purdue Hackers ID');
    // Admins may also submit requests (they are attendees too); nothing else crosses roles.
    if (needed === role || (needed === 'attendee' && role === 'admin')) return;
    throw new CommandError('FORBIDDEN', `This action requires the ${needed} role`);
  }

  /** Async validation that must not run inside a transaction. */
  private async precheck(actor: Actor, envelope: CommandEnvelope): Promise<ResolvedSource | null> {
    if (envelope.type !== 'request.submit' && envelope.type !== 'master.add') return null;
    const { url } = envelope.payload as { url: string };
    const ref = this.source.canonicalize(url);
    if (envelope.type === 'request.submit') {
      const night = this.openNight();
      if (!night) throw new CommandError('NIGHT_CLOSED', 'Requests are closed until an organizer opens tonight’s session');
      const identity = (actor as { identity: Identity }).identity;
      if (this.quotaUsed(night.id, identity.key) >= this.policy.quotaPerNight) {
        throw new CommandError('QUOTA_EXCEEDED', `You have used all ${this.policy.quotaPerNight} requests for tonight`);
      }
    }
    const purpose: MediaPurpose = envelope.type === 'request.submit' ? 'request' : 'master';
    const resolved = await this.source.resolve(ref, purpose);
    if (resolved.artworkUrl !== undefined && !isHttpArtworkUrl(resolved.artworkUrl)) {
      throw new PortError('SOURCE_UNAVAILABLE', 'Source returned an invalid artwork URL');
    }
    if (!(resolved.durationSec > 0)) throw new PortError('SOURCE_UNAVAILABLE', 'Recording has no known duration');
    if (purpose === 'request' && resolved.durationSec >= this.policy.requestMaxSec) {
      throw new PortError('DURATION_REJECTED', 'Requests must be shorter than six minutes');
    }
    if (purpose === 'master' && resolved.durationSec > this.policy.masterMaxSec) {
      throw new PortError('DURATION_REJECTED', 'Master items are limited to four hours');
    }
    const expected = (envelope.payload as { expectRecordingKey?: string }).expectRecordingKey;
    if (envelope.type === 'request.submit' && expected !== undefined && expected !== resolved.recordingKey) {
      throw new CommandError('GUARD_MISMATCH', 'This link now resolves to a different recording than the one you previewed; check the link again');
    }
    return resolved;
  }

  /**
   * Read-only "what would submit do now?". Reserves nothing, writes nothing, bumps no revision.
   * Same validation order as submit; post-resolution rejections come back as a verdict so the
   * requester still sees what the link resolved to.
   */
  private async preview(actor: Actor, envelope: CommandEnvelope): Promise<CommandResponse> {
    const identity = (actor as { identity: Identity }).identity;
    const now = this.clock.now();
    const recent = (this.previewTimes.get(identity.key) ?? []).filter((t) => now - t < this.previewLimit.windowMs);
    if (recent.length >= this.previewLimit.max) {
      this.previewTimes.set(identity.key, recent);
      return this.failure(envelope.commandId, new CommandError('RATE_LIMITED', 'Too many link checks; wait a moment and try again', true));
    }
    this.previewTimes.set(identity.key, [...recent, now]);
    try {
      const ref = this.source.canonicalize((envelope.payload as { url: string }).url);
      const night = this.openNight();
      if (!night) throw new CommandError('NIGHT_CLOSED', 'Requests are closed until an organizer opens tonight’s session');
      const used = this.quotaUsed(night.id, identity.key);
      const limit = this.policy.quotaPerNight;
      if (used >= limit) throw new CommandError('QUOTA_EXCEEDED', `You have used all ${limit} requests for tonight`);
      const resolved = await this.source.resolve(ref, 'request');
      if (!(resolved.durationSec > 0)) throw new PortError('SOURCE_UNAVAILABLE', 'Recording has no known duration');
      let verdict: PreviewResult['verdict'] = { accepted: true };
      if (resolved.durationSec >= this.policy.requestMaxSec) {
        verdict = { accepted: false, code: 'DURATION_REJECTED', message: 'Requests must be shorter than six minutes' };
      } else if (this.openNight()?.id === night.id && this.db.prepare("select 1 from requests where night_id = ? and recording_key = ? and status in ('preparing','ready')")
        .get(night.id, resolved.recordingKey)) {
        verdict = { accepted: false, code: 'DUPLICATE_REQUEST', message: 'That recording is already waiting in the queue' };
      }
      const result: PreviewResult = {
        source: { provider: resolved.ref.provider, canonicalUrl: resolved.ref.canonicalUrl, title: resolved.title, artist: resolved.artist,
          durationSec: resolved.durationSec, recordingKey: resolved.recordingKey },
        match: resolved.match ?? null,
        verdict,
        quota: { used, limit, remaining: limit - used },
      };
      return { ok: true, commandId: envelope.commandId, revision: this.revision(), result: result as never, replayed: false };
    } catch (error) {
      return this.failure(envelope.commandId, error);
    }
  }

  private apply(tx: Tx, actor: Actor, envelope: CommandEnvelope, resolved: ResolvedSource | null): unknown {
    const p = envelope.payload as Record<string, unknown>;
    const type = envelope.type;
    switch (type) {
      case 'night.open': return this.nightOpen(tx);
      case 'night.close': return this.nightClose(tx);
      case 'master.add': return this.masterAdd(tx, resolved!);
      case 'master.remove': return this.masterRemove(tx, p.entryId as string);
      case 'master.move': return this.move(tx, 'master_items', p.entryId as string, p.afterEntryId as string | null);
      case 'request.remove': return this.requestRemove(tx, p.entryId as string);
      case 'request.move': return this.move(tx, 'requests', p.entryId as string, p.afterEntryId as string | null);
      case 'request.preview': throw new Error('request.preview is handled before the transaction');
      case 'request.submit': return this.requestSubmit(tx, (actor as { identity: Identity }).identity, resolved!);
      case 'playback.play': return this.play(tx);
      case 'playback.pause': return this.pause(tx);
      case 'playback.seek': return this.seek(tx, p.entryId as string, p.positionSec as number);
      case 'playback.skip': return this.skip(tx, p.entryId as string);
      case 'queue.mode': return this.setMode(tx, p.mode as QueueMode);
      case 'queue.interval': return this.setInterval(tx, p.periodMs as number | null);
      case 'request.playNow': return this.playNow(tx, p.entryId as string);
      case 'playback.volume': {
        tx.pb.volume = p.volume as number;
        this.bumpEpoch(tx);
        return this.emit(tx, 'playback.volume', { volume: tx.pb.volume });
      }
      case 'device.pairing.create': return this.pairingCreate(tx, p.name as string);
      case 'device.revoke': return this.deviceRevoke(tx, p.deviceId as string);
      case 'device.pair': return this.devicePair(tx, p.code as string);
      case 'display.connect': return this.displayConnect(tx, p.secret as string);
      case 'player.claim': return this.claim(tx, (actor as { deviceId: string }).deviceId, p.takeover === true);
      case 'player.release': return this.release(tx, (actor as { deviceId: string }).deviceId, p.generation as number);
      case 'player.report': return this.report(tx, (actor as { deviceId: string }).deviceId, envelope.payload as PlayerReport);
    }
  }

  // ---------------------------------------------------------- transactions

  private transaction<T, R>(fn: (tx: Tx) => T, finish: (result: T, revision: number) => R): R {
    this.db.exec('begin immediate');
    let revision = this.revision();
    let result: R;
    let changed = false;
    try {
      const pb = this.db.prepare('select * from playback where id = 1').get() as unknown as PlaybackRow;
      const tx: Tx = { now: this.clock.now(), pb, events: [], touched: false };
      const value = fn(tx);
      this.savePlayback(tx.pb);
      if (tx.events.length || tx.touched) {
        changed = true;
        revision++;
        this.db.prepare("update meta set value = ? where key = 'revision'").run(String(revision));
        const insert = this.db.prepare('insert into events(revision, at, type, data) values(?, ?, ?, ?)');
        for (const event of tx.events) insert.run(revision, tx.now, event.type, JSON.stringify(event.data));
      }
      result = finish(value, revision);
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
    if (changed) for (const listener of this.listeners) listener(revision);
    return result;
  }

  private savePlayback(pb: PlaybackRow) {
    const keys = Object.keys(pb).filter((k) => k !== 'id');
    this.db.prepare(`update playback set ${keys.map((k) => `${k} = ?`).join(', ')} where id = 1`)
      .run(...keys.map((k) => (pb as unknown as Record<string, string | number | null>)[k]!));
  }

  private emit(tx: Tx, type: string, data: Record<string, unknown> = {}) {
    tx.events.push({ type, data });
    return {};
  }

  // ------------------------------------------------------------ queries

  private openNight(): NightRow | undefined {
    return this.db.prepare("select * from nights where status = 'open'").get() as unknown as NightRow | undefined;
  }

  private quotaUsed(nightId: string, requesterKey: string): number {
    return (this.db.prepare('select count(*) as n from requests where night_id = ? and requester_key = ? and charged = 1 and refunded = 0')
      .get(nightId, requesterKey) as { n: number }).n;
  }

  private master(id: string | null): MasterRow | undefined {
    return id ? this.db.prepare('select * from master_items where id = ?').get(id) as unknown as MasterRow | undefined : undefined;
  }

  private request(id: string | null): RequestRow | undefined {
    return id ? this.db.prepare('select * from requests where id = ?').get(id) as unknown as RequestRow | undefined : undefined;
  }

  private nextReadyRequest(): RequestRow | undefined {
    const night = this.openNight();
    if (!night) return undefined;
    return this.db.prepare("select * from requests where night_id = ? and status = 'ready' order by order_key limit 1")
      .get(night.id) as unknown as RequestRow | undefined;
  }

  private playableMaster(row: MasterRow | undefined): row is MasterRow {
    return !!row && !row.removed && row.status === 'ready' && row.failures < this.policy.masterFailureLimit && !!row.asset;
  }

  /** Next playable master after the cursor, looping the organizer's list. */
  private nextMaster(cursor: string | null, includeCursor: boolean): MasterRow | undefined {
    const all = this.db.prepare('select * from master_items where removed = 0 order by order_key').all() as unknown as MasterRow[];
    const at = this.master(cursor);
    const key = at?.order_key ?? -Infinity;
    const after = all.filter((r) => (includeCursor ? r.order_key >= key : r.order_key > key));
    return [...after, ...all].find((r) => this.playableMaster(r));
  }

  private isMix(row: MasterRow) {
    return row.duration_sec > this.policy.mixThresholdSec;
  }

  // ------------------------------------------------------- scheduler core

  private newLoad(tx: Tx, startPosition: number) {
    tx.pb.load_id++;
    tx.pb.start_position = startPosition;
    tx.pb.seek_seq = 0;
    this.bumpEpoch(tx);
  }

  private bumpEpoch(tx: Tx) {
    tx.pb.epoch++;
    tx.pb.desired_at = tx.now;
    tx.pb.unconfirmed_noted = 0;
  }

  /** Select the next master item (or the cursor itself) and load it from the start. */
  private selectMaster(tx: Tx, includeCursor: boolean) {
    const next = this.nextMaster(tx.pb.master_cursor, includeCursor);
    if (!next) {
      tx.pb.current_id = null;
      if (tx.pb.intent === 'playing' || !tx.pb.no_master) {
        tx.pb.intent = 'paused';
        tx.pb.no_master = 1;
        this.emit(tx, 'alert.no_master_available');
      }
      return;
    }
    tx.pb.no_master = 0;
    tx.pb.current_id = next.id;
    tx.pb.master_cursor = next.id;
    tx.pb.master_position = 0;
    this.newLoad(tx, 0);
    this.emit(tx, 'master.loaded', { entryId: next.id });
  }

  private startRequest(tx: Tx, request: RequestRow, suspend: Suspended | null) {
    tx.pb.phase = 'request';
    tx.pb.current_id = request.id;
    tx.pb.suspended = suspend ? JSON.stringify(suspend) : null;
    this.db.prepare("update requests set status = 'playing', play_attempts = play_attempts + 1 where id = ?").run(request.id);
    this.newLoad(tx, 0);
    this.emit(tx, 'request.started', { entryId: request.id, suspendedMaster: suspend });
  }

  /** End of a request turn (played, failed, skipped, removed, archived): fresh master period. */
  private finishTurn(tx: Tx, resetPeriod: boolean) {
    const suspended = this.suspendedOf(tx.pb);
    if (tx.pb.mode === 'requests' && this.openNight()) {
      // Requests only: chain the next ready request, else wait silently. The suspended master stays pinned.
      tx.pb.period_started_at = null;
      const next = this.nextReadyRequest();
      if (next) this.startRequest(tx, next, suspended);
      else this.enterRequestsIdle(tx, suspended);
      this.emit(tx, 'turn.finished', {});
      return;
    }
    tx.pb.phase = 'master';
    tx.pb.suspended = null;
    // Only `auto` runs the request interval.
    tx.pb.period_started_at = resetPeriod && tx.pb.mode === 'auto' ? tx.now : null;
    const resume = this.master(suspended?.itemId ?? null);
    if (suspended && this.playableMaster(resume)) {
      tx.pb.current_id = resume.id;
      tx.pb.master_cursor = resume.id;
      tx.pb.master_position = suspended.positionSec;
      this.newLoad(tx, suspended.positionSec);
      this.emit(tx, 'master.resumed', { entryId: resume.id, positionSec: suspended.positionSec });
    } else {
      this.selectMaster(tx, false);
    }
    this.emit(tx, 'turn.finished', {});
  }

  /** Admin-configured interval, else the default. Always read through here so the override applies to a running countdown. */
  private periodOf(pb: PlaybackRow) {
    return pb.period_ms ?? this.policy.periodMs;
  }

  private periodDue(tx: Tx) {
    return tx.pb.mode === 'auto' && tx.pb.phase === 'master' && tx.pb.period_started_at !== null
      && tx.now - tx.pb.period_started_at >= this.periodOf(tx.pb);
  }

  private suspendCurrent(tx: Tx): Suspended | null {
    const current = this.master(tx.pb.current_id);
    return current ? { itemId: current.id, positionSec: tx.pb.master_position, loadId: tx.pb.load_id } : null;
  }

  private suspendedOf(pb: PlaybackRow): Suspended | null {
    return pb.suspended ? (JSON.parse(pb.suspended) as Suspended) : null;
  }

  /** `requests` mode with nothing ready: silent, master stays suspended and pinned. */
  private enterRequestsIdle(tx: Tx, suspended: Suspended | null) {
    tx.pb.phase = 'request';
    tx.pb.current_id = null;
    tx.pb.suspended = suspended ? JSON.stringify(suspended) : null;
    this.newLoad(tx, 0); // a new load fences reports for the request that just ended
    this.emit(tx, 'requests.idle', {});
  }

  /** Time/queue-driven transitions. Runs after every command and on reconcile. */
  private schedule(tx: Tx) {
    const pb = tx.pb;
    if (pb.phase === 'master' && pb.current_id === null) {
      if (pb.autostart && this.openNight() && this.nextMaster(pb.master_cursor, true)) {
        pb.intent = 'playing';
        pb.autostart = 0;
        pb.period_started_at = tx.now;
      }
      // Clear the exhausted-master alert once items become playable; stay paused until an organizer plays.
      if (pb.no_master && this.nextMaster(pb.master_cursor, true)) {
        pb.no_master = 0;
        this.emit(tx, 'alert.cleared');
      }
      if (pb.intent === 'playing') this.selectMaster(tx, true);
    }
    if (pb.mode === 'requests' && pb.phase === 'request' && pb.current_id === null && this.openNight()) {
      const next = this.nextReadyRequest();
      if (next) this.startRequest(tx, next, this.suspendedOf(pb));
      return;
    }
    if (!this.periodDue(tx)) return;
    const request = this.nextReadyRequest();
    if (!request) {
      // Empty turn: reset the elapsed period, even while deliberately paused; never touch audio.
      pb.period_started_at = tx.now;
      this.emit(tx, 'turn.empty', {});
      return;
    }
    if (pb.intent === 'paused') return; // due; wait for organizer resume
    const current = this.master(pb.current_id);
    if (current && this.isMix(current)) {
      this.startRequest(tx, request, { itemId: current.id, positionSec: pb.master_position, loadId: pb.load_id });
    }
    // Normal song: the transition happens on its `ended` report.
  }

  private onMasterEnded(tx: Tx) {
    if (this.periodDue(tx) && tx.pb.intent === 'playing') {
      const request = this.nextReadyRequest();
      if (request) {
        const finished = tx.pb.current_id;
        this.startRequest(tx, request, null);
        // After the request, continue with the item after the finished song.
        if (finished) tx.pb.master_cursor = finished;
        return;
      }
    }
    this.selectMaster(tx, false);
  }

  private onRequestEnded(tx: Tx, status: 'played' | 'skipped' | 'removed' | 'failed' | 'archived', error: string | null = null) {
    const id = tx.pb.current_id;
    if (id) {
      const refund = status === 'failed' ? 1 : 0;
      this.db.prepare('update requests set status = ?, refunded = max(refunded, ?), error = ?, finished_at = ? where id = ?')
        .run(status, refund, error, tx.now, id);
      this.emit(tx, `request.${status}`, { entryId: id, refunded: refund === 1 });
    }
    this.finishTurn(tx, status !== 'archived');
  }

  // ------------------------------------------------------- admin commands

  private nightOpen(tx: Tx) {
    if (this.openNight()) throw new CommandError('NIGHT_ALREADY_OPEN', 'A night session is already open');
    const id = randomUUID();
    this.db.prepare("insert into nights values(?, 'open', ?, null)").run(id, tx.now);
    this.resetMode(tx);
    // Starting a session starts its music, including when preparation finishes later.
    tx.pb.intent = 'playing';
    if (tx.pb.current_id === null) this.selectMaster(tx, true);
    tx.pb.autostart = tx.pb.current_id === null ? 1 : 0;
    tx.pb.period_started_at = tx.pb.current_id === null ? null : tx.now;
    this.bumpEpoch(tx);
    this.emit(tx, 'night.opened', { nightId: id });
    return { nightId: id };
  }

  private nightClose(tx: Tx) {
    const night = this.openNight();
    if (!night) throw new CommandError('NIGHT_CLOSED', 'No night session is open');
    tx.pb.intent = 'paused';
    tx.pb.autostart = 0;
    this.bumpEpoch(tx);
    this.resetMode(tx); // before the playing request is archived, so it resumes master instead of chaining
    if (tx.pb.phase === 'request') this.onRequestEnded(tx, 'archived');
    this.db.prepare("update requests set status = 'archived', finished_at = ? where night_id = ? and status in ('preparing','ready')")
      .run(tx.now, night.id);
    this.db.prepare("update nights set status = 'closed', closed_at = ? where id = ?").run(tx.now, night.id);
    tx.pb.period_started_at = null;
    this.emit(tx, 'night.closed', { nightId: night.id });
    return {};
  }

  private masterAdd(tx: Tx, resolved: ResolvedSource) {
    const id = randomUUID();
    const max = (this.db.prepare('select max(order_key) as k from master_items').get() as { k: number | null }).k ?? 0;
    this.db.prepare(`insert into master_items(id, order_key, source_url, provider, title, artist, artwork_url, duration_sec, recording_key,
      selection, status, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?) `)
      .run(id, max + 1, resolved.ref.canonicalUrl, resolved.ref.provider, resolved.title, resolved.artist, resolved.artworkUrl ?? null, resolved.durationSec,
        resolved.recordingKey, JSON.stringify(resolved.selection ?? null), tx.now);
    this.emit(tx, 'master.added', { entryId: id });
    return { entryId: id };
  }

  private masterRemove(tx: Tx, id: string) {
    const row = this.master(id);
    if (!row || row.removed) throw new CommandError('NOT_FOUND', 'Master item not found');
    this.db.prepare('update master_items set removed = 1 where id = ?').run(id);
    const suspended = tx.pb.suspended ? (JSON.parse(tx.pb.suspended) as Suspended) : null;
    if (suspended?.itemId === id) tx.pb.suspended = null;
    if (tx.pb.phase === 'master' && tx.pb.current_id === id) this.selectMaster(tx, false);
    this.emit(tx, 'master.removed', { entryId: id });
    return {};
  }

  private move(tx: Tx, table: 'master_items' | 'requests', id: string, after: string | null) {
    const scope = table === 'requests'
      ? "night_id = (select id from nights where status = 'open') and status in ('preparing','ready')"
      : 'removed = 0';
    const rows = this.db.prepare(`select id, order_key from ${table} where ${scope} order by order_key`).all() as { id: string; order_key: number }[];
    if (!rows.some((r) => r.id === id)) throw new CommandError('NOT_FOUND', 'Entry is not in this queue');
    if (after === id) throw new CommandError('BAD_REQUEST', 'Cannot move an entry after itself');
    const others = rows.filter((r) => r.id !== id);
    const index = after === null ? -1 : others.findIndex((r) => r.id === after);
    if (after !== null && index < 0) throw new CommandError('NOT_FOUND', 'Target entry is not in this queue');
    const before = index >= 0 ? others[index]!.order_key : (others[0]?.order_key ?? 1) - 1;
    const next = others[index + 1]?.order_key ?? before + 2;
    this.db.prepare(`update ${table} set order_key = ? where id = ?`).run((before + next) / 2, id);
    this.emit(tx, `${table === 'requests' ? 'request' : 'master'}.moved`, { entryId: id, afterEntryId: after });
    return {};
  }

  private requestRemove(tx: Tx, id: string) {
    const row = this.request(id);
    if (!row || !['preparing', 'ready', 'playing'].includes(row.status)) throw new CommandError('NOT_FOUND', 'Request is not waiting or playing');
    if (row.status === 'playing') {
      this.onRequestEnded(tx, 'removed');
    } else {
      this.db.prepare("update requests set status = 'removed', finished_at = ? where id = ?").run(tx.now, id);
      this.emit(tx, 'request.removed', { entryId: id, refunded: false });
    }
    return {};
  }

  private play(tx: Tx) {
    tx.pb.autostart = 0;
    if (tx.pb.intent === 'playing') return {};
    tx.pb.intent = 'playing';
    if (tx.pb.phase === 'master') {
      if (tx.pb.current_id === null) this.selectMaster(tx, true);
      if (tx.pb.current_id === null) throw new CommandError('NOTHING_PLAYABLE', 'No playable master music; add or fix master items');
      if (tx.pb.period_started_at === null && tx.pb.mode === 'auto') tx.pb.period_started_at = tx.now;
    }
    this.bumpEpoch(tx);
    this.emit(tx, 'playback.play');
    return {};
  }

  private pause(tx: Tx) {
    tx.pb.autostart = 0;
    if (tx.pb.intent === 'paused') return {};
    tx.pb.intent = 'paused';
    this.bumpEpoch(tx);
    this.emit(tx, 'playback.pause');
    return {};
  }

  private requireCurrent(tx: Tx, entryId: string) {
    if (tx.pb.current_id !== entryId) throw new CommandError('GUARD_MISMATCH', 'That item is no longer playing');
  }

  private seek(tx: Tx, entryId: string, positionSec: number) {
    this.requireCurrent(tx, entryId);
    const row = tx.pb.phase === 'master' ? this.master(entryId) : this.request(entryId);
    const duration = row ? (JSON.parse(row.asset ?? 'null') as AssetDescriptor | null)?.durationSec ?? row.duration_sec : 0;
    const position = Math.min(positionSec, Math.max(0, duration - 0.5));
    tx.pb.start_position = position;
    tx.pb.seek_seq++;
    this.bumpEpoch(tx);
    tx.pb.seek_epoch = tx.pb.epoch;
    if (tx.pb.phase === 'master') tx.pb.master_position = position;
    // Seeking never moves period_started_at.
    this.emit(tx, 'playback.seek', { entryId, positionSec: position });
    return {};
  }

  private skip(tx: Tx, entryId: string) {
    this.requireCurrent(tx, entryId);
    if (tx.pb.phase === 'request') {
      this.onRequestEnded(tx, 'skipped');
    } else {
      // Advances without resetting the accumulated master period.
      this.emit(tx, 'master.skipped', { entryId });
      this.selectMaster(tx, false);
    }
    return {};
  }

  // ------------------------------------------------------- queue control

  private resetMode(tx: Tx) {
    if (tx.pb.mode === 'auto') return;
    this.emit(tx, 'queue.mode', { mode: 'auto', previous: tx.pb.mode });
    tx.pb.mode = 'auto';
  }

  /**
   * Absolute, idempotent mode set. Explicit organizer actions cut in immediately (the interrupted
   * master item, mix or song, is suspended and resumes at its saved position). A request that is
   * already playing is never cut off: it finishes, and `finishTurn` applies the new mode.
   */
  private setMode(tx: Tx, mode: QueueMode) {
    const pb = tx.pb;
    if (pb.mode === mode) return {};
    if (mode === 'requests' && !this.openNight()) throw new CommandError('NIGHT_CLOSED', 'Start a night session before playing requests only');
    const previous = pb.mode;
    pb.mode = mode;
    this.emit(tx, 'queue.mode', { mode, previous });
    if (mode === 'requests') {
      pb.period_started_at = null;
      if (pb.phase === 'master') {
        const suspended = this.suspendCurrent(tx);
        const next = this.nextReadyRequest();
        if (next) this.startRequest(tx, next, suspended);
        else this.enterRequestsIdle(tx, suspended);
      }
      return {};
    }
    if (previous === 'requests' && pb.phase === 'request' && pb.current_id === null) this.finishTurn(tx, true); // resume the suspended master
    // Leaving `master` starts a fresh interval now (no catch-up turn); non-auto modes run no interval.
    pb.period_started_at = mode === 'auto' && pb.phase === 'master' && pb.current_id !== null ? tx.now : null;
    return {};
  }

  /** Applies to the running countdown: due = periodStartedAt + the new period. */
  private setInterval(tx: Tx, periodMs: number | null) {
    if (periodMs !== null && (periodMs < this.policy.periodMinMs || periodMs > this.policy.periodMaxMs)) {
      throw new CommandError('BAD_REQUEST', `The request interval must be between ${this.policy.periodMinMs / 60_000} and ${this.policy.periodMaxMs / 60_000} minutes`);
    }
    if (tx.pb.period_ms !== periodMs) {
      this.emit(tx, 'queue.interval', { periodMs, previousMs: this.periodOf(tx.pb) });
      tx.pb.period_ms = periodMs;
    }
    return {};
  }

  private playNow(tx: Tx, entryId: string) {
    if (!this.openNight()) throw new CommandError('NIGHT_CLOSED', 'No night session is open');
    const row = this.request(entryId);
    if (!row || row.night_id !== this.openNight()!.id || !['preparing', 'ready'].includes(row.status)) {
      throw new CommandError('NOT_FOUND', 'That request is no longer waiting');
    }
    if (row.status !== 'ready') throw new CommandError('NOT_READY', 'That request is still loading');
    if (tx.pb.phase === 'request' && tx.pb.current_id !== null) {
      throw new CommandError('GUARD_MISMATCH', 'A request is already playing; move this one to the top of the queue instead');
    }
    // Master phase: suspend the current item (mix or song). Idle requests-only: keep the existing suspended master.
    this.startRequest(tx, row, tx.pb.phase === 'master' ? this.suspendCurrent(tx) : this.suspendedOf(tx.pb));
    this.emit(tx, 'request.play_now', { entryId });
    return {};
  }

  // ------------------------------------------------------ device authority

  private pairingCreate(tx: Tx, name: string) {
    const bytes = randomBytes(8);
    const code = [...bytes].map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
    const expiresAt = tx.now + this.policy.pairingCodeMs;
    this.db.prepare('insert into pairing_codes values(?, ?, ?, 0)').run(hash(code), name, expiresAt);
    this.emit(tx, 'device.pairing_created', { name, expiresAt });
    return { code, expiresAt };
  }

  private devicePair(tx: Tx, code: string) {
    const row = this.db.prepare('select * from pairing_codes where code_hash = ?').get(hash(code.toUpperCase())) as
      { code_hash: string; name: string; expires_at: number; used: number } | undefined;
    if (!row || row.used || row.expires_at <= tx.now) throw new CommandError('PAIRING_INVALID', 'Pairing code is invalid, used, or expired');
    this.db.prepare('update pairing_codes set used = 1 where code_hash = ?').run(row.code_hash);
    const deviceId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    this.db.prepare('insert into devices(id, name, token_hash, paired_at) values(?, ?, ?, ?)').run(deviceId, row.name, hash(secret), tx.now);
    this.emit(tx, 'device.paired', { deviceId, name: row.name });
    return { deviceId, token: `${deviceId}.${secret}` };
  }

  /** Returns the device ID for a valid, unrevoked bearer token. */
  authenticateDevice(token: string): string | null {
    const [deviceId, secret] = token.split('.');
    if (!deviceId || !secret) return null;
    const row = this.db.prepare('select token_hash, revoked from devices where id = ?').get(deviceId) as { token_hash: string; revoked: number } | undefined;
    return row && !row.revoked && row.token_hash === hash(secret) ? deviceId : null;
  }

  private deviceRevoke(tx: Tx, deviceId: string) {
    const changes = this.db.prepare('update devices set revoked = 1 where id = ? and revoked = 0').run(deviceId).changes;
    if (!changes) throw new CommandError('NOT_FOUND', 'Device not found or already revoked');
    if (tx.pb.lease_device === deviceId) this.dropLease(tx);
    this.emit(tx, 'device.revoked', { deviceId });
    return {};
  }

  private leaseLive(pb: PlaybackRow, now: number) {
    return pb.lease_device !== null && pb.lease_expires > now;
  }

  private displayConnect(tx: Tx, secret: string) {
    if (!this.openNight()) throw new CommandError('NIGHT_CLOSED', 'An admin needs to start a session');
    const existing = this.db.prepare('select id, revoked from devices where automatic = 1 and token_hash = ?')
      .get(hash(secret)) as { id: string; revoked: number } | undefined;
    if (existing?.revoked) throw new CommandError('DEVICE_REVOKED', 'This display was disconnected by an admin');
    if (this.leaseLive(tx.pb, tx.now)) {
      if (existing?.id !== tx.pb.lease_device) throw new CommandError('LEASE_HELD', 'Sound is playing on another display', true);
      // A lost connection response can be retried by this page only, without fencing itself.
      tx.pb.lease_expires = tx.now + this.policy.leaseMs;
      return { deviceId: existing.id, token: `${existing.id}.${secret}`, generation: tx.pb.generation, expiresAt: tx.pb.lease_expires };
    }
    const deviceId = existing?.id ?? randomUUID();
    // Automatic registrations are transient: retain only the current one, not a row per refresh.
    this.db.prepare('delete from devices where automatic = 1 and id != ?').run(deviceId);
    if (!existing) this.db.prepare('insert into devices(id, name, token_hash, paired_at, automatic) values(?, ?, ?, ?, 1)')
      .run(deviceId, 'Display browser', hash(secret), tx.now);
    const lease = this.claim(tx, deviceId, false);
    return { deviceId, token: `${deviceId}.${secret}`, ...lease };
  }

  private dropLease(tx: Tx) {
    tx.pb.generation++; // fences every report from the previous holder
    tx.pb.lease_device = null;
    tx.pb.lease_expires = 0;
    tx.pb.observed = null;
  }

  private claim(tx: Tx, deviceId: string, takeover: boolean) {
    const pb = tx.pb;
    if (this.leaseLive(pb, tx.now) && (pb.lease_device !== deviceId || !takeover)) {
      throw new CommandError('LEASE_HELD', pb.lease_device === deviceId
        ? 'This device already plays in another tab; confirm takeover to move playback here'
        : 'Another paired display holds playback; an admin must revoke it or wait for its lease to expire', true);
    }
    pb.generation++;
    pb.lease_device = deviceId;
    pb.lease_expires = tx.now + this.policy.leaseMs;
    pb.acked_epoch = null;
    pb.observed = JSON.stringify({ deviceId, status: 'needs_activation', loadId: null, ackedEpoch: null, positionSec: null, observedAt: tx.now, error: null });
    this.emit(tx, 'player.claimed', { deviceId, generation: pb.generation });
    return { generation: pb.generation, expiresAt: pb.lease_expires };
  }

  private requireLease(tx: Tx, deviceId: string, generation: number) {
    if (tx.pb.lease_device !== deviceId || tx.pb.generation !== generation || !this.leaseLive(tx.pb, tx.now)) {
      throw new CommandError('STALE_LEASE', 'This player no longer holds playback; reclaim and reload current state');
    }
  }

  private release(tx: Tx, deviceId: string, generation: number) {
    this.requireLease(tx, deviceId, generation);
    this.dropLease(tx);
    this.emit(tx, 'player.released', { deviceId });
    return {};
  }

  private report(tx: Tx, deviceId: string, report: PlayerReport) {
    const pb = tx.pb;
    this.requireLease(tx, deviceId, report.generation);
    if (report.loadId > pb.load_id || report.epoch > pb.epoch) throw new CommandError('BAD_REQUEST', 'Report is ahead of desired state');
    pb.lease_expires = tx.now + this.policy.leaseMs;
    const suspended = pb.suspended ? (JSON.parse(pb.suspended) as Suspended) : null;
    if (report.previous && suspended && report.previous.loadId === suspended.loadId) {
      // Actual paused position of the interrupted mix replaces the last heartbeat.
      suspended.positionSec = report.previous.positionSec;
      pb.suspended = JSON.stringify(suspended);
    } else if (suspended && pb.phase === 'request' && pb.current_id === null && report.loadId === suspended.loadId) {
      // Requests-only idle sends no new load, so no `previous` is ever reported. The player still holds the
      // suspended master paused and keeps heartbeating its actual position; track it as the checkpoint.
      suspended.positionSec = report.positionSec;
      pb.suspended = JSON.stringify(suspended);
    }
    if (report.loadId !== pb.load_id) return {}; // stale load: lease renewed, no transitions
    const before = pb.observed ? (JSON.parse(pb.observed) as ObservedPlayback) : null;
    const acked = Math.max(pb.acked_epoch ?? 0, report.epoch);
    const observed: ObservedPlayback = {
      deviceId, status: report.status, loadId: report.loadId, ackedEpoch: acked, positionSec: report.positionSec,
      observedAt: tx.now, error: report.error ?? null,
    };
    pb.observed = JSON.stringify(observed);
    if (before?.status !== observed.status || pb.acked_epoch !== acked) tx.touched = true;
    pb.acked_epoch = acked;
    if (pb.phase === 'master' && pb.current_id) pb.master_position = report.positionSec;
    if (report.status === 'ended' && report.epoch >= pb.seek_epoch) {
      this.emit(tx, 'player.ended', { kind: pb.phase, entryId: pb.current_id });
      if (pb.phase === 'master') this.onMasterEnded(tx);
      else this.onRequestEnded(tx, 'played');
    } else if (report.status === 'error') {
      this.onPlaybackError(tx, report.error ?? 'Playback error', report.positionSec);
    }
    return {};
  }

  private onPlaybackError(tx: Tx, error: string, positionSec: number) {
    const pb = tx.pb;
    this.emit(tx, 'player.error', { kind: pb.phase, entryId: pb.current_id, error });
    if (pb.phase === 'request') {
      const row = this.request(pb.current_id);
      if (!row) return;
      if (row.play_attempts < this.policy.playbackAttempts) {
        this.db.prepare('update requests set play_attempts = play_attempts + 1 where id = ?').run(row.id);
        this.newLoad(tx, positionSec);
      } else {
        this.onRequestEnded(tx, 'failed', error);
      }
      return;
    }
    const row = this.master(pb.current_id);
    if (!row) return;
    const failures = row.failures + 1;
    const unusable = failures >= this.policy.masterFailureLimit;
    this.db.prepare('update master_items set failures = ?, error = ?, status = ? where id = ?')
      .run(failures, error, unusable ? 'unusable' : row.status, row.id);
    if (unusable) this.selectMaster(tx, false);
    else this.newLoad(tx, positionSec);
  }

  // ----------------------------------------------------- attendee commands

  private requestSubmit(tx: Tx, identity: Identity, resolved: ResolvedSource) {
    const night = this.openNight();
    if (!night) throw new CommandError('NIGHT_CLOSED', 'Requests are closed until an organizer opens tonight’s session');
    const used = this.quotaUsed(night.id, identity.key);
    if (used >= this.policy.quotaPerNight) throw new CommandError('QUOTA_EXCEEDED', `You have used all ${this.policy.quotaPerNight} requests for tonight`);
    const duplicate = this.db.prepare("select id from requests where night_id = ? and recording_key = ? and status in ('preparing','ready')")
      .get(night.id, resolved.recordingKey);
    if (duplicate) throw new CommandError('DUPLICATE_REQUEST', 'That recording is already waiting in the queue');
    const id = randomUUID();
    const max = (this.db.prepare('select max(order_key) as k from requests where night_id = ?').get(night.id) as { k: number | null }).k ?? 0;
    this.db.prepare(`insert into requests(id, night_id, requester_key, requester_name, order_key, source_url, provider, title, artist, artwork_url,
      duration_sec, recording_key, selection, status, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?) `)
      .run(id, night.id, identity.key, identity.displayName, max + 1, resolved.ref.canonicalUrl, resolved.ref.provider, resolved.title,
        resolved.artist, resolved.artworkUrl ?? null, resolved.durationSec, resolved.recordingKey, JSON.stringify(resolved.selection ?? null), tx.now);
    this.emit(tx, 'request.submitted', { entryId: id });
    const limit = this.policy.quotaPerNight;
    return { entryId: id, quota: { used: used + 1, limit, remaining: limit - used - 1 } };
  }

  // ---------------------------------------------------------- reconcile

  /**
   * Time-based transitions, lease expiry, ack timeouts, preparation, and cache
   * retention. Safe to call repeatedly and concurrently; also run on a server
   * interval so no browser timer is the only trigger.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileOnce().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async reconcileOnce() {
    this.tick();
    await this.pumpPreparation();
    this.tick();
    await this.syncRetention();
  }

  /** Synchronous time-driven transitions. */
  tick() {
    this.transaction((tx) => {
      const pb = tx.pb;
      if (pb.lease_device && pb.lease_expires <= tx.now) {
        const observed = pb.observed ? (JSON.parse(pb.observed) as ObservedPlayback) : null;
        if (observed?.status !== 'offline') {
          pb.observed = JSON.stringify({ ...(observed ?? {}), deviceId: pb.lease_device, status: 'offline' });
          this.emit(tx, 'player.offline', { deviceId: pb.lease_device });
        }
      }
      if (pb.acked_epoch !== pb.epoch && pb.desired_at && tx.now - pb.desired_at >= this.policy.ackTimeoutMs && !pb.unconfirmed_noted && pb.lease_device) {
        pb.unconfirmed_noted = 1;
        this.emit(tx, 'player.unconfirmed', { epoch: pb.epoch });
      }
      this.schedule(tx);
    }, () => undefined);
  }

  private resolvedFromRow(row: MasterRow | RequestRow): ResolvedSource {
    return {
      ref: canonicalizeUrl(row.source_url),
      title: row.title,
      artist: row.artist,
      durationSec: row.duration_sec,
      recordingKey: row.recording_key,
      ...(row.artwork_url ? { artworkUrl: row.artwork_url } : {}),
      selection: JSON.parse(row.selection),
    };
  }

  private async pumpPreparation() {
    const pending = [
      ...(this.db.prepare("select * from master_items where status = 'preparing' and removed = 0").all() as unknown as MasterRow[])
        .map((row) => ({ table: 'master_items' as const, row: row as MasterRow | RequestRow })),
      ...(this.db.prepare("select * from requests where status = 'preparing'").all() as unknown as RequestRow[])
        .map((row) => ({ table: 'requests' as const, row: row as MasterRow | RequestRow })),
    ];
    await Promise.all(pending.map(async ({ table, row }) => {
      if (this.preparing.has(row.id)) return;
      this.preparing.add(row.id);
      try {
        const jobId = row.job_id ?? await this.startJob(table, row);
        if (jobId) await this.pollJob(table, { ...row, job_id: jobId });
      } finally {
        this.preparing.delete(row.id);
      }
    }));
  }

  private async startJob(table: 'master_items' | 'requests', row: MasterRow | RequestRow): Promise<string | null> {
    const purpose: MediaPurpose = table === 'requests' ? 'request' : 'master';
    try {
      const { jobId } = await this.media.prepare(this.resolvedFromRow(row), purpose);
      return this.transaction((tx) => {
        const changes = this.db.prepare(`update ${table} set job_id = ?, prep_attempts = prep_attempts + 1 where id = ? and status = 'preparing' and job_id is null`)
          .run(jobId, row.id).changes;
        if (changes) this.emit(tx, 'media.preparing', { entryId: row.id });
        return changes ? jobId : null;
      }, (value) => value);
    } catch (error) {
      const technical = error instanceof PortError ? error.technical : true;
      this.transaction((tx) => {
        this.db.prepare(`update ${table} set prep_attempts = prep_attempts + 1 where id = ?`).run(row.id);
        if (!technical || row.prep_attempts + 1 >= this.policy.preparationAttempts) {
          this.preparationFailed(tx, table, row.id, (error as Error).message);
        }
      }, () => undefined);
      return null;
    }
  }

  private async pollJob(table: 'master_items' | 'requests', row: MasterRow | RequestRow) {
    let state: JobState;
    try {
      state = await this.media.job(row.job_id!);
    } catch {
      return; // transient polling failure; try again next reconcile
    }
    if (state.status !== 'ready' && state.status !== 'failed') return;
    this.transaction((tx) => {
      const current = this.db.prepare(`select status, job_id, prep_attempts from ${table} where id = ?`).get(row.id) as
        { status: string; job_id: string | null; prep_attempts: number } | undefined;
      if (!current || current.status !== 'preparing' || current.job_id !== row.job_id) return; // superseded
      if (state.status === 'ready') {
        // The prepared asset's validated duration is authoritative over metadata.
        const duration = state.asset.durationSec;
        if (table === 'requests' && duration >= this.policy.requestMaxSec) {
          this.preparationFailed(tx, table, row.id, 'Prepared recording is six minutes or longer');
          return;
        }
        this.db.prepare(`update ${table} set status = 'ready', asset = ?, duration_sec = ?, error = null where id = ?`)
          .run(JSON.stringify(state.asset), duration, row.id);
        this.emit(tx, 'media.ready', { entryId: row.id });
      } else if (state.retryable && current.prep_attempts < this.policy.preparationAttempts) {
        this.db.prepare(`update ${table} set job_id = null where id = ?`).run(row.id);
        this.emit(tx, 'media.retrying', { entryId: row.id });
      } else {
        this.preparationFailed(tx, table, row.id, state.error);
      }
    }, () => undefined);
  }

  private preparationFailed(tx: Tx, table: 'master_items' | 'requests', id: string, error: string) {
    if (table === 'requests') {
      // Technical preparation failures refund the allowance like playback failures.
      this.db.prepare("update requests set status = 'failed', refunded = 1, error = ?, finished_at = ? where id = ? and status = 'preparing'")
        .run(error.slice(0, 300), tx.now, id);
      this.emit(tx, 'request.failed', { entryId: id, refunded: true });
    } else {
      this.db.prepare("update master_items set status = 'failed', error = ? where id = ?").run(error.slice(0, 300), id);
      this.emit(tx, 'master.failed', { entryId: id });
    }
  }

  /** Every asset the queue still needs: current, suspended mix, ready masters, waiting requests. */
  retentionSet(): string[] {
    const ids = new Set<string>();
    const add = (asset: string | null) => {
      const parsed = asset ? (JSON.parse(asset) as AssetDescriptor) : null;
      if (parsed) ids.add(parsed.assetId);
    };
    for (const row of this.db.prepare("select asset from master_items where removed = 0 and status = 'ready'").all() as { asset: string | null }[]) add(row.asset);
    for (const row of this.db.prepare("select asset from requests where status in ('ready','playing')").all() as { asset: string | null }[]) add(row.asset);
    const pb = this.db.prepare('select current_id, suspended from playback').get() as { current_id: string | null; suspended: string | null };
    const suspended = pb.suspended ? (JSON.parse(pb.suspended) as Suspended) : null;
    add(this.master(suspended?.itemId ?? null)?.asset ?? null);
    add(this.master(pb.current_id)?.asset ?? this.request(pb.current_id)?.asset ?? null);
    return [...ids].sort();
  }

  private async syncRetention() {
    const set = this.retentionSet();
    const key = JSON.stringify(set);
    if (key === this.retained) return;
    const revision = Number((this.db.prepare("update meta set value = cast(value as integer) + 1 where key = 'retention_revision' returning value")
      .get() as { value: string }).value);
    try {
      await this.media.retain(revision, set);
      this.retained = key;
    } catch (error) {
      console.warn('[jukebox] cache retention sync failed; will retry', (error as Error).message);
    }
  }

  // ---------------------------------------------------------- snapshots

  events(after: number, limit = 200): EventRecord[] {
    return (this.db.prepare('select * from events where revision > ? order by seq limit ?').all(after, limit) as
      { seq: number; revision: number; at: number; type: string; data: string }[])
      .map((e) => ({ seq: e.seq, revision: e.revision, at: e.at, type: e.type, data: JSON.parse(e.data) }));
  }

  snapshot(actor: Actor): Snapshot {
    const role = this.roleOf(actor);
    const now = this.clock.now();
    const pb = this.db.prepare('select * from playback where id = 1').get() as unknown as PlaybackRow;
    const nightRow = this.openNight() ??
      (this.db.prepare('select * from nights order by opened_at desc limit 1').get() as unknown as NightRow | undefined);
    const night = nightRow ? { id: nightRow.id, status: nightRow.status, openedAt: nightRow.opened_at, closedAt: nightRow.closed_at } : null;
    const live = this.leaseLive(pb, now);
    const observedRaw = pb.observed ? (JSON.parse(pb.observed) as ObservedPlayback) : null;
    const observed = observedRaw && pb.lease_device ? { ...observedRaw, status: live ? observedRaw.status : 'offline' as const } : null;
    const currentRow = pb.phase === 'master' ? this.master(pb.current_id) : this.request(pb.current_id);
    const suspended = pb.suspended ? (JSON.parse(pb.suspended) as Suspended) : null;
    const suspendedRow = this.master(suspended?.itemId ?? null);
    const nextMasterRow = pb.phase === 'request' && suspendedRow
      ? suspendedRow
      : this.nextMaster(pb.master_cursor, pb.phase === 'master' && pb.current_id === null);
    const ready = !!this.nextReadyRequest();
    const due = pb.mode === 'auto' && pb.phase === 'master' && pb.period_started_at !== null && now - pb.period_started_at >= this.periodOf(pb) && ready;
    const confirmation = pb.current_id === null ? 'none'
      : (pb.acked_epoch ?? -1) >= pb.epoch ? 'confirmed'
      : now - pb.desired_at >= this.policy.ackTimeoutMs ? 'unconfirmed' : 'requested';
    const identity = actor.kind === 'user' ? actor.identity : null;
    const isAdmin = role === 'admin';
    const visible = isAdmin
      ? "status in ('preparing','ready','playing') or (finished_at is not null and finished_at > ?)"
      : "status in ('preparing','ready','playing') or (requester_key = ? and finished_at > ?)";
    const requestRows = night && nightRow
      ? this.db.prepare(`select * from requests where night_id = ? and (${visible}) order by case status when 'playing' then 0 else 1 end, order_key`)
        .all(...(isAdmin ? [nightRow.id, now - 3600_000] : [nightRow.id, identity?.key ?? '', now - 3600_000])) as unknown as RequestRow[]
      : [];
    const alerts: Alert[] = [];
    if (pb.no_master) alerts.push({ code: 'no_master_available', message: 'No playable master music; playback is paused' });
    if (pb.lease_device && !live) alerts.push({ code: 'player_offline', message: 'The paired display is offline' });
    if (confirmation === 'unconfirmed') alerts.push({ code: 'unconfirmed_command', message: 'The player has not confirmed the latest change' });

    const snapshot: Snapshot = {
      contractVersion: CONTRACT_VERSION,
      revision: this.revision(),
      serverTime: now,
      role,
      night,
      schedule: {
        phase: pb.phase,
        intent: pb.intent,
        periodStartedAt: pb.period_started_at,
        periodMs: this.periodOf(pb),
        periodDefaultMs: this.policy.periodMs,
        periodMinMs: this.policy.periodMinMs,
        periodMaxMs: this.policy.periodMaxMs,
        mode: pb.mode,
        requestsIdle: pb.mode === 'requests' && pb.phase === 'request' && pb.current_id === null,
        turnDue: due,
        dueReason: !due ? null : pb.intent === 'paused' ? 'paused' : !live ? 'offline' : 'song_end',
      },
      nowPlaying: currentRow
        ? { kind: pb.phase, entryId: currentRow.id, title: currentRow.title, artist: currentRow.artist, durationSec: currentRow.duration_sec,
            ...(currentRow.artwork_url ? { artworkUrl: currentRow.artwork_url } : {}) }
        : null,
      nextMaster: nextMasterRow ? { title: nextMasterRow.title, artist: nextMasterRow.artist, durationSec: nextMasterRow.duration_sec,
        ...(nextMasterRow.artwork_url ? { artworkUrl: nextMasterRow.artwork_url } : {}) } : null,
      suspendedMaster: suspended && suspendedRow ? { entryId: suspendedRow.id, title: suspendedRow.title, positionSec: suspended.positionSec } : null,
      playback: {
        desiredEpoch: pb.current_id ? pb.epoch : null,
        ackedEpoch: pb.acked_epoch,
        confirmation,
        observed: role === 'public' || role === 'attendee' ? (observed ? { ...observed, deviceId: '', error: null } : null) : observed,
        volume: pb.volume,
      },
      requests: requestRows.map((r) => ({
        id: r.id,
        title: r.title,
        artist: r.artist,
        ...(r.artwork_url ? { artworkUrl: r.artwork_url } : {}),
        durationSec: r.duration_sec,
        status: r.status as RequestStatus,
        ...(isAdmin ? { requester: r.requester_name, sourceUrl: r.source_url, error: r.error ?? undefined } : {}),
        ...(identity && r.requester_key === identity.key ? { mine: true, sourceUrl: r.source_url, error: r.error ?? undefined } : {}),
      })),
      alerts: isAdmin ? alerts : [],
    };
    if (isAdmin) {
      snapshot.master = (this.db.prepare('select * from master_items where removed = 0 order by order_key').all() as unknown as MasterRow[]).map((m) => ({
        id: m.id, title: m.title, artist: m.artist, durationSec: m.duration_sec, isMix: this.isMix(m),
        ...(m.artwork_url ? { artworkUrl: m.artwork_url } : {}),
        status: m.status as MasterStatus, sourceUrl: m.source_url,
      }));
      snapshot.devices = (this.db.prepare('select * from devices order by paired_at').all() as { id: string; name: string; revoked: number; paired_at: number }[])
        .map((d) => ({ id: d.id, name: d.name, revoked: !!d.revoked, pairedAt: d.paired_at, holdsLease: live && pb.lease_device === d.id }));
    }
    if (identity && night?.status === 'open') {
      const used = this.quotaUsed(night.id, identity.key);
      snapshot.quota = { used, limit: this.policy.quotaPerNight, remaining: Math.max(0, this.policy.quotaPerNight - used) };
    }
    if (role === 'player') {
      const holds = live && pb.lease_device === (actor as { deviceId: string }).deviceId;
      snapshot.lease = holds ? { deviceId: pb.lease_device!, generation: pb.generation, expiresAt: pb.lease_expires } : null;
      snapshot.desired = holds ? this.desired(pb, currentRow) : null;
    }
    return snapshot;
  }

  private desired(pb: PlaybackRow, row: MasterRow | RequestRow | undefined): DesiredPlayback | null {
    const asset = row?.asset ? (JSON.parse(row.asset) as AssetDescriptor) : null;
    if (!row || !asset) return null;
    return {
      epoch: pb.epoch, loadId: pb.load_id, kind: pb.phase, entryId: row.id, asset, startPositionSec: pb.start_position,
      seekSeq: pb.seek_seq, intent: pb.intent, volume: pb.volume,
    };
  }
}

export type { CommandPayloads };

/** One service process per database: command dedupe and scheduling assume a single writer. */
function acquireLock(path: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`Another Jukebox service (pid ${pid}) is using this database`);
      unlinkSync(path); // stale lock from a crashed process
    }
  }
}
