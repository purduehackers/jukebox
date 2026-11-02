// Shared Jukebox contract, version 1. Owned by the phase-2 integration owner.
// UI/player phases import these types; propose changes instead of forking them.

export const CONTRACT_VERSION = 1;

// ---- Policy constants (production values; tests inject a short period) ----
export const POLICY = {
  /** Elapsed master playback before a request turn. Pause/buffering count. */
  periodMs: 15 * 60 * 1000,
  /** Master tracks strictly longer than this are interruptible mixes. */
  mixThresholdSec: 360,
  /** Requests must be strictly shorter than this. */
  requestMaxSec: 360,
  /** Accepted submissions per PH ID per admin-managed night. */
  quotaPerNight: 3,
  /** Paired player lease; renewed by every accepted report. */
  leaseMs: 15_000,
  /** Expected player report cadence; also the resume checkpoint tolerance. */
  heartbeatMs: 5_000,
  /** Desired playback not acknowledged by the player within this is "unconfirmed". */
  ackTimeoutMs: 10_000,
  /** Bounded attempts per item before a technical failure is final. */
  preparationAttempts: 2,
  playbackAttempts: 2,
  /** Master items are skipped permanently after this many technical failures. */
  masterFailureLimit: 2,
  pairingCodeMs: 10 * 60 * 1000,
  masterMaxSec: 4 * 60 * 60,
} as const;

export type Policy = { -readonly [K in keyof typeof POLICY]: number };

// ---- Identity and roles ----
export type Role = 'public' | 'attendee' | 'admin' | 'player';

export interface Identity {
  /** Stable key: `${issuer}#${subject}`; never an email or display name. */
  key: string;
  issuer: string;
  subject: string;
  displayName: string;
  /** PH ID `roles` claim values, e.g. organizer/admin. */
  roles: string[];
}

// ---- Sources and media ----
export type Provider = 'youtube' | 'spotify' | 'apple_music' | 'fixture';

export interface SourceRef {
  provider: Provider;
  itemId: string;
  canonicalUrl: string;
}

export interface ResolvedSource {
  ref: SourceRef;
  title: string;
  artist: string | null;
  durationSec: number;
  /** Identity of the playable recording, used for duplicate detection. */
  recordingKey: string;
  /** Optional source artwork/thumbnail; only absolute HTTP(S) URLs are accepted. */
  artworkUrl?: string;
  /** Opaque, worker-specific selection; never a signed media URL. */
  selection: unknown;
  /** Set when a Spotify/Apple link was matched to a different playable recording. */
  match?: MatchInfo;
}

/** The playable recording a catalog link was matched to, shown to the requester before submit. */
export interface MatchInfo {
  via: Provider;
  url: string;
  title: string;
  artist: string | null;
  durationSec: number;
  /** Short human-readable reasons the match was accepted (e.g. same title, duration within 3 s). */
  reasons: string[];
}

export interface AssetDescriptor {
  assetId: string;
  url: string;
  mime: string;
  codec: string;
  durationSec: number;
  byteLength: number;
}

export type MediaPurpose = 'master' | 'request';

// ---- Queues ----
export type MasterStatus = 'preparing' | 'ready' | 'failed' | 'unusable';

export type RequestStatus =
  | 'preparing'
  | 'ready'
  | 'playing'
  | 'played'
  | 'failed' // technical failure; allowance refunded
  | 'removed' // admin removal; not refunded
  | 'skipped' // admin skip while playing; not refunded
  | 'archived'; // night ended before it played

export interface MasterEntryView {
  id: string;
  title: string;
  artist: string | null;
  artworkUrl?: string;
  durationSec: number | null;
  isMix: boolean;
  status: MasterStatus;
  sourceUrl: string;
}

export interface RequestEntryView {
  id: string;
  title: string;
  artist: string | null;
  artworkUrl?: string;
  durationSec: number | null;
  status: RequestStatus;
  /** Present for admins only. */
  requester?: string;
  /** Present for the signed-in attendee who owns the entry. */
  mine?: boolean;
  sourceUrl?: string;
  error?: string;
}

// ---- Playback ----
export type Intent = 'playing' | 'paused';
export type Phase = 'master' | 'request';
export type ObservedStatus =
  | 'loading'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'error'
  | 'needs_activation';

/** What the server wants the paired player to do. Idempotent; reconcile, don't replay. */
export interface DesiredPlayback {
  /** Increments on every desired change (source, intent, seek, volume). */
  epoch: number;
  /** Increments only when the source changes; reports for other loads are stale. */
  loadId: number;
  kind: Phase;
  entryId: string;
  asset: AssetDescriptor;
  /** Position to load/seek to for this loadId; also the latest explicit seek. */
  startPositionSec: number;
  /** Increments with each explicit seek, so a repeated seek to the same position applies. */
  seekSeq: number;
  intent: Intent;
  volume: number;
}

export interface ObservedPlayback {
  deviceId: string;
  status: ObservedStatus | 'offline';
  loadId: number | null;
  ackedEpoch: number | null;
  positionSec: number | null;
  observedAt: number | null;
  error: string | null;
}

export interface Snapshot {
  contractVersion: number;
  revision: number;
  serverTime: number;
  role: Role;
  night: { id: string; status: 'open' | 'closed'; openedAt: number; closedAt: number | null } | null;
  schedule: {
    phase: Phase;
    intent: Intent;
    /** Null until master playback starts in this night. */
    periodStartedAt: number | null;
    periodMs: number;
    /** A request is due but waiting (normal song end or deliberate pause). */
    turnDue: boolean;
    dueReason: 'song_end' | 'paused' | 'offline' | null;
  };
  nowPlaying: {
    kind: Phase;
    entryId: string;
    title: string;
    artist: string | null;
    artworkUrl?: string;
    durationSec: number | null;
  } | null;
  /** Public-safe next master item, or the suspended mix to resume after a request. */
  nextMaster?: { title: string; artist: string | null; durationSec: number; artworkUrl?: string } | null;
  /** Suspended mix waiting for the request to finish. */
  suspendedMaster: { entryId: string; title: string; positionSec: number } | null;
  /** Requested vs player-confirmed. `confirmed` means the player acked this epoch. */
  playback: {
    desiredEpoch: number | null;
    ackedEpoch: number | null;
    confirmation: 'none' | 'requested' | 'confirmed' | 'unconfirmed';
    observed: ObservedPlayback | null;
    volume: number;
  };
  requests: RequestEntryView[];
  alerts: Alert[];
  /** Admin only. */
  master?: MasterEntryView[];
  /** Admin only. */
  devices?: DeviceView[];
  /** Signed-in attendee only. */
  quota?: { used: number; limit: number; remaining: number };
  /** Paired player only, while it holds the lease. */
  desired?: DesiredPlayback | null;
  lease?: { deviceId: string; generation: number; expiresAt: number } | null;
}

export type Alert = { code: 'no_master_available' | 'player_offline' | 'unconfirmed_command'; message: string };

export interface DeviceView {
  id: string;
  name: string;
  revoked: boolean;
  pairedAt: number;
  holdsLease: boolean;
}

// ---- Commands ----
export interface CommandEnvelope<T extends CommandType = CommandType> {
  /** Client-generated UUID, stable across retries of the same intent. */
  commandId: string;
  type: T;
  /** Optional strict CAS against the global snapshot revision. */
  expectedRevision?: number;
  payload: CommandPayloads[T];
}

export interface CommandPayloads {
  // Admin: nights
  'night.open': Record<string, never>;
  'night.close': Record<string, never>;
  // Admin: master library
  'master.add': { url: string };
  'master.remove': { entryId: string };
  'master.move': { entryId: string; afterEntryId: string | null };
  // Admin: request queue
  'request.remove': { entryId: string };
  'request.move': { entryId: string; afterEntryId: string | null };
  // Admin: playback (guards prevent a retried/late action applying to the wrong item)
  'playback.play': Record<string, never>;
  'playback.pause': Record<string, never>;
  'playback.seek': { entryId: string; positionSec: number };
  'playback.skip': { entryId: string };
  'playback.volume': { volume: number };
  // Admin: devices
  'device.pairing.create': { name: string };
  'device.revoke': { deviceId: string };
  // Attendee
  'request.submit': { url: string; /** Reject (GUARD_MISMATCH) if the link now resolves to a different recording than previewed. */ expectRecordingKey?: string };
  /** Read-only: resolve and judge a link without reserving allowance or touching the queue. */
  'request.preview': { url: string };
  // Unauthenticated holder of a pairing code
  'device.pair': { code: string };
  /** Display tab connects itself during an open session. Secret is unique to this page instance. */
  'display.connect': { secret: string };
  // Paired player
  'player.claim': { takeover?: boolean };
  'player.release': { generation: number };
  'player.report': PlayerReport;
}

export type CommandType = keyof CommandPayloads;

export interface PlayerReport {
  generation: number;
  /** Highest desired epoch the player has applied. */
  epoch: number;
  loadId: number;
  status: ObservedStatus;
  positionSec: number;
  /** Actual paused position of the previous load, sent with the first report of a new load. */
  previous?: { loadId: number; positionSec: number };
  error?: string;
}

export interface CommandResults {
  'device.pairing.create': { code: string; expiresAt: number };
  'device.pair': { deviceId: string; token: string };
  'display.connect': { deviceId: string; token: string; generation: number; expiresAt: number };
  'player.claim': { generation: number; expiresAt: number };
  'request.submit': { entryId: string; quota: { used: number; limit: number; remaining: number } };
  'request.preview': PreviewResult;
  'master.add': { entryId: string };
  'night.open': { nightId: string };
}

export interface PreviewResult {
  source: { provider: Provider; canonicalUrl: string; title: string; artist: string | null; durationSec: number; recordingKey: string };
  match: MatchInfo | null;
  /** What `request.submit` would do right now. Not a reservation: it can change before submit. */
  verdict: { accepted: true } | { accepted: false; code: ErrorCode; message: string };
  quota: { used: number; limit: number; remaining: number };
}

export type CommandResult<T extends CommandType> = T extends keyof CommandResults ? CommandResults[T] : Record<string, never>;

export type CommandResponse<T extends CommandType = CommandType> =
  | { ok: true; commandId: string; revision: number; result: CommandResult<T>; replayed: boolean }
  | { ok: false; commandId: string | null; error: ApiError; replayed: boolean };

// ---- Errors ----
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_MISMATCH'
  | 'GUARD_MISMATCH'
  | 'NIGHT_CLOSED'
  | 'NIGHT_ALREADY_OPEN'
  | 'QUOTA_EXCEEDED'
  | 'DUPLICATE_REQUEST'
  | 'INVALID_SOURCE'
  | 'SOURCE_UNSUPPORTED'
  | 'SOURCE_UNAVAILABLE'
  | 'DURATION_REJECTED'
  | 'RATE_LIMITED'
  | 'LEASE_HELD'
  | 'STALE_LEASE'
  | 'DEVICE_REVOKED'
  | 'PAIRING_INVALID'
  | 'NOTHING_PLAYABLE'
  | 'INTERNAL';

export interface ApiError {
  code: ErrorCode;
  message: string;
  /** True only when retrying the same commandId later may succeed. */
  retryable: boolean;
  /** Optional structured context, e.g. `{kind:'ambiguous', candidates}` for a link that needs disambiguation. */
  details?: Record<string, unknown>;
}

// ---- Durable events (audit log and change feed) ----
export interface EventRecord {
  /** Monotonic event sequence; several events may share one revision. */
  seq: number;
  revision: number;
  at: number;
  type: string;
  data: Record<string, unknown>;
}
