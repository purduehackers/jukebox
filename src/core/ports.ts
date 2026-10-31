// Replaceable boundaries. Scheduling never calls source tools or the browser directly.
import type { AssetDescriptor, Identity, MediaPurpose, ResolvedSource, SourceRef } from '../contract/types.ts';

export interface Clock {
  now(): number;
}

/** Thrown by adapters for user-visible, typed failures. */
export class PortError extends Error {
  code: 'INVALID_SOURCE' | 'SOURCE_UNSUPPORTED' | 'SOURCE_UNAVAILABLE' | 'DURATION_REJECTED';
  /** Technical failures (network, worker) may be retried; validation failures may not. */
  technical: boolean;
  constructor(code: PortError['code'], message: string, technical = false) {
    super(message);
    this.code = code;
    this.technical = technical;
  }
}

/** Metadata/matching. Must not fetch arbitrary URLs; canonicalize is a pure allowlist. */
export interface SourcePort {
  canonicalize(url: string): SourceRef;
  /** Bounded metadata resolution of a playable audio-only recording. No media download. */
  resolve(ref: SourceRef, purpose: MediaPurpose): Promise<ResolvedSource>;
}

export type JobState =
  | { status: 'queued' | 'preparing' }
  | { status: 'ready'; asset: AssetDescriptor }
  | { status: 'failed'; error: string; retryable: boolean };

/** Audio-only preparation/cache (phase-1 Python worker in production-like local runs). */
export interface MediaPort {
  prepare(source: ResolvedSource, purpose: MediaPurpose): Promise<{ jobId: string }>;
  job(jobId: string): Promise<JobState>;
  /**
   * Replace the full set of assets the queue service needs retained. Idempotent;
   * the worker ignores a revision lower than one it already applied.
   */
  retain(revision: number, assetIds: string[]): Promise<void>;
}

export interface LoginStart {
  redirectUrl: string;
  /** Opaque state to keep in an HttpOnly cookie until the callback. */
  state: string;
}

/** PH ID (OIDC) or a local fake. The service only consumes verified identities. */
export interface IdentityPort {
  readonly kind: 'phid' | 'fake';
  beginLogin(returnTo: string): Promise<LoginStart>;
  completeLogin(callback: URLSearchParams, state: string): Promise<{ identity: Identity; returnTo: string }>;
}
