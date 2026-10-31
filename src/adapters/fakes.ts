// Deterministic local adapters for development and tests. No network or credentials.
import { randomUUID } from 'node:crypto';
import type { AssetDescriptor, Identity, MediaPurpose, ResolvedSource, SourceRef } from '../contract/types.ts';
import type { Clock, IdentityPort, JobState, LoginStart, MediaPort, SourcePort } from '../core/ports.ts';
import { PortError } from '../core/ports.ts';
import { canonicalizeUrl } from '../core/sources.ts';

export class FakeClock implements Clock {
  t: number;
  constructor(start = Date.UTC(2026, 9, 30, 21, 0, 0)) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export const systemClock: Clock = { now: () => Date.now() };

export interface FakeTrack {
  title: string;
  artist?: string;
  durationSec: number;
  /** Defaults to `${provider}:${itemId}`; share one to model the same recording via two links. */
  recordingKey?: string;
}

/** Catalog keyed by canonical URL. Unknown items are unavailable, never invented. */
export class FakeSource implements SourcePort {
  catalog = new Map<string, FakeTrack>();
  failNext: PortError | null = null;
  resolveCalls = 0;
  canonicalize(url: string): SourceRef {
    return canonicalizeUrl(url);
  }
  add(url: string, track: FakeTrack) {
    this.catalog.set(canonicalizeUrl(url).canonicalUrl, track);
    return this;
  }
  async resolve(ref: SourceRef, _purpose: MediaPurpose): Promise<ResolvedSource> {
    this.resolveCalls++;
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = null;
      throw failure;
    }
    if (ref.provider === 'spotify' || ref.provider === 'apple_music') {
      throw new PortError('SOURCE_UNSUPPORTED', 'Spotify/Apple Music matching is not implemented yet');
    }
    const track = this.catalog.get(ref.canonicalUrl);
    if (!track) throw new PortError('SOURCE_UNAVAILABLE', 'That recording is unavailable');
    return {
      ref,
      title: track.title,
      artist: track.artist ?? null,
      durationSec: track.durationSec,
      recordingKey: track.recordingKey ?? `${ref.provider}:${ref.itemId}`,
      selection: { fake: ref.canonicalUrl },
    };
  }
}

interface FakeJob {
  source: ResolvedSource;
  state: JobState;
}

/** Jobs stay `preparing` until `complete()`/`fail()` unless `autoReady` is true. */
export class FakeMedia implements MediaPort {
  jobs = new Map<string, FakeJob>();
  autoReady = true;
  retained: { revision: number; assetIds: string[] } = { revision: 0, assetIds: [] };
  retainCalls = 0;
  /** Canonical URLs whose next preparation fails with the given retryability. */
  failures = new Map<string, boolean>();
  async prepare(source: ResolvedSource, _purpose: MediaPurpose) {
    const jobId = randomUUID();
    const fail = this.failures.get(source.ref.canonicalUrl);
    let state: JobState = { status: 'preparing' };
    if (fail !== undefined) {
      this.failures.delete(source.ref.canonicalUrl);
      state = { status: 'failed', error: 'Injected preparation failure', retryable: fail };
    } else if (this.autoReady) {
      state = { status: 'ready', asset: this.asset(source) };
    }
    this.jobs.set(jobId, { source, state });
    return { jobId };
  }
  async job(jobId: string): Promise<JobState> {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 'failed', error: 'Unknown job', retryable: false };
    return job.state;
  }
  complete(jobId: string) {
    const job = this.jobs.get(jobId)!;
    job.state = { status: 'ready', asset: this.asset(job.source) };
  }
  fail(jobId: string, retryable: boolean) {
    this.jobs.get(jobId)!.state = { status: 'failed', error: 'Injected preparation failure', retryable };
  }
  async retain(revision: number, assetIds: string[]) {
    this.retainCalls++;
    if (revision >= this.retained.revision) this.retained = { revision, assetIds: [...assetIds].sort() };
  }
  private asset(source: ResolvedSource): AssetDescriptor {
    const assetId = randomUUID();
    return { assetId, url: `/media/${assetId}`, mime: 'audio/webm', codec: 'opus', durationSec: source.durationSec, byteLength: 1000 };
  }
}

/** Local sign-in without PH ID. Only enable in loopback development and tests. */
export class FakeIdentity implements IdentityPort {
  readonly kind = 'fake' as const;
  async beginLogin(returnTo: string): Promise<LoginStart> {
    const state = randomUUID();
    return { state: `${state}|${returnTo}`, redirectUrl: `/auth/fake?state=${state}` };
  }
  async completeLogin(callback: URLSearchParams, state: string) {
    const [expected, returnTo = '/'] = state.split('|');
    if (!expected || callback.get('state') !== expected) throw new Error('Login state mismatch');
    const subject = callback.get('sub') ?? '';
    if (!/^[a-z0-9_-]{1,40}$/.test(subject)) throw new Error('Fake login needs a simple sub');
    const roles = (callback.get('roles') ?? '').split(',').filter((r) => r === 'organizer' || r === 'admin');
    const identity: Identity = { key: `fake#${subject}`, issuer: 'fake', subject, displayName: subject, roles };
    return { identity, returnTo };
  }
}
