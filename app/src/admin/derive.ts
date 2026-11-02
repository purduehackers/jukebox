// Pure view-model helpers for /admin. No React, no I/O: unit-tested against the real service.
import type { ApiError, MasterEntryView, RequestEntryView, Snapshot } from '../../../src/contract/types.ts';
import type { Intent } from './intents.ts';
import { POLICY } from '../../../src/contract/types.ts';

/** Server wall-clock "now", extrapolated from when the snapshot was received. */
export function serverNowAt(snapshot: Snapshot, receivedAtLocal: number, localNow: number) {
  return snapshot.serverTime + Math.max(0, localNow - receivedAtLocal);
}

// ---------------------------------------------------------------- player

export type PlayerState = 'no_display' | 'offline' | 'needs_activation' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export function playerState(snapshot: Snapshot): PlayerState {
  const observed = snapshot.playback.observed;
  if (!observed) return 'no_display';
  if (observed.status === 'offline') return 'offline';
  return observed.status;
}

export const PLAYER_LABEL: Record<PlayerState, string> = {
  no_display: 'Display not open',
  offline: 'Display offline',
  needs_activation: 'Display needs a click',
  loading: 'Loading',
  buffering: 'Buffering',
  playing: 'Playing',
  paused: 'Paused',
  ended: 'Song ended',
  error: 'Display error',
};

export type Confirmation = Snapshot['playback']['confirmation'];

/** Plain-language distinction between accepted, acknowledged by the player, and unacknowledged. */
export const CONFIRMATION_LABEL: Record<Confirmation, { label: string; detail: string }> = {
  none: { label: '', detail: '' },
  requested: { label: 'Sending to display…', detail: 'The display hasn’t confirmed it yet.' },
  confirmed: { label: 'On the display', detail: 'The display confirmed it.' },
  unconfirmed: { label: 'Display didn’t respond', detail: `No reply for ${POLICY.ackTimeoutMs / 1000} s, so the change may not have happened.` },
};

export interface PositionEstimate {
  positionSec: number | null;
  durationSec: number | null;
  remainingSec: number | null;
  /** `live`: extrapolated from a playing, confirmed display. `reported`: last report, not advancing. */
  basis: 'live' | 'reported' | 'stale' | 'unconfirmed' | 'unknown';
}

/**
 * Estimate where playback is. The display reports every ~5 s, so a playing position is
 * extrapolated from its report time. A pending acknowledgement can be volume-only, so it
 * must not reset the clock to the last heartbeat. Keep uncertainty separate from position.
 */
export function estimatePosition(snapshot: Snapshot, serverNow: number): PositionEstimate {
  const duration = snapshot.nowPlaying?.durationSec ?? null;
  const observed = snapshot.playback.observed;
  if (!snapshot.nowPlaying || !observed || observed.positionSec === null || observed.observedAt === null) {
    return { positionSec: null, durationSec: duration, remainingSec: null, basis: 'unknown' };
  }
  let basis: PositionEstimate['basis'];
  let position = observed.positionSec;
  if (observed.status === 'offline') basis = 'stale';
  else {
    const advancing = observed.status === 'playing' && snapshot.schedule.intent === 'playing';
    if (advancing) position += Math.max(0, serverNow - observed.observedAt) / 1000;
    basis = snapshot.playback.confirmation !== 'confirmed' ? 'unconfirmed' : advancing ? 'live' : 'reported';
  }
  if (duration !== null) position = Math.min(position, duration);
  return { positionSec: position, durationSec: duration, remainingSec: duration === null ? null : Math.max(0, duration - position), basis };
}

// ------------------------------------------------------------ request turn

export type TurnKind = 'night_closed' | 'in_request' | 'not_started' | 'counting' | 'due' | 'elapsed_empty' | 'master_only' | 'requests_only' | 'requests_idle';

export interface TurnView {
  kind: TurnKind;
  headline: string;
  detail: string;
  /** Remaining time of the master period; null when it is not running. Never an ETA for the request. */
  periodRemainingMs: number | null;
  readyRequests: number;
  preparingRequests: number;
}

/** "15 min", "1.5 min": the interval as a person would say it. */
export const formatMinutes = (ms: number) => `${Math.round((ms / 60_000) * 10) / 10} min`;

export const formatClock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * Describe the next request turn from the same elapsed-time facts the scheduler uses
 * (periodStartedAt/periodMs/serverTime). Deliberately no exact "request plays at" time:
 * a normal song finishes first, pauses defer the turn, and an empty turn resets the period.
 */
export function describeTurn(snapshot: Snapshot, serverNow: number): TurnView {
  const { schedule } = snapshot;
  const waiting = snapshot.requests.filter((r) => r.status === 'ready' || r.status === 'preparing');
  const ready = waiting.filter((r) => r.status === 'ready').length;
  const preparing = waiting.length - ready;
  const base = { readyRequests: ready, preparingRequests: preparing, periodRemainingMs: null as number | null };
  if (!snapshot.night || snapshot.night.status !== 'open') {
    return { ...base, kind: 'night_closed', headline: 'Night not started', detail: 'Start the night to play music and take requests.' };
  }
  if (schedule.mode === 'master') {
    return { ...base, kind: 'master_only', headline: 'Master only', detail: `Request turns are off${ready + preparing ? `; ${ready + preparing} waiting` : ''}. “Play now” still plays one.` };
  }
  if (schedule.mode === 'requests') {
    if (schedule.requestsIdle) {
      return { ...base, kind: 'requests_idle', headline: 'Waiting for requests', detail: 'Nothing is playing. The next request starts as soon as it is ready.' };
    }
    return { ...base, kind: 'requests_only', headline: 'Requests only', detail: `${ready + preparing ? `${ready + preparing} more waiting. ` : 'Then silence until the next request. '}Master music resumes where it left off when you switch back.` };
  }
  if (schedule.phase === 'request') {
    return { ...base, kind: 'in_request', headline: 'Request playing', detail: 'The playlist picks up where it left off when this ends.' };
  }
  if (schedule.periodStartedAt === null) {
    return { ...base, kind: 'not_started', headline: 'Request timer not started', detail: 'It starts once music is playing.' };
  }
  const remaining = schedule.periodStartedAt + schedule.periodMs - serverNow;
  const where = [
    schedule.intent === 'paused' ? 'Paused — the timer keeps running.' : null,
    snapshot.playback.observed?.status === 'offline' ? 'Display offline — the server keeps time and catches up when it reconnects.' : null,
  ].filter(Boolean).join(' ');
  if (schedule.turnDue) {
    const reason = {
      song_end: 'Plays when this song ends.',
      paused: 'Press Play to start it.',
      offline: 'Plays when the display reconnects.',
    }[schedule.dueReason ?? 'song_end'];
    return { ...base, kind: 'due', headline: 'Request up next', detail: reason };
  }
  if (remaining <= 0) {
    return { ...base, kind: 'elapsed_empty', headline: 'No request ready', detail: `Playlist keeps going; next chance in ${formatMinutes(schedule.periodMs)}.${preparing ? ` ${preparing} still loading.` : ''}` };
  }
  const current = snapshot.master?.find((m) => m.id === snapshot.nowPlaying?.entryId);
  const interrupt = !snapshot.nowPlaying ? null : current?.isMix ? 'This mix gets cut in and resumes later.' : 'Waits for this song to end.';
  const consequence = ready ? `${ready} ready request${ready === 1 ? '' : 's'} will take this turn.` : 'No ready request yet.';
  return {
    ...base,
    kind: 'counting',
    periodRemainingMs: remaining,
    headline: `Next request in ${formatClock(remaining)}`,
    detail: [consequence, interrupt, where].filter(Boolean).join(' '),
  };
}

// ----------------------------------------------------------------- queues

export type Direction = 'up' | 'down';

/** `afterEntryId` for request/master `*.move` when shifting the entry at `index` one place. */
export function moveAnchor(ids: readonly string[], index: number, direction: Direction): { afterEntryId: string | null } | null {
  if (index < 0 || index >= ids.length) return null;
  if (direction === 'up') return index === 0 ? null : { afterEntryId: ids[index - 2] ?? null };
  return index === ids.length - 1 ? null : { afterEntryId: ids[index + 1]! };
}

export const waitingRequests = (snapshot: Snapshot): RequestEntryView[] => snapshot.requests.filter((r) => r.status === 'ready' || r.status === 'preparing');
export const playingRequest = (snapshot: Snapshot): RequestEntryView | undefined => snapshot.requests.find((r) => r.status === 'playing');
export const masterList = (snapshot: Snapshot): MasterEntryView[] => snapshot.master ?? [];

/** Order signature used to tell an organizer when someone else rearranged a queue. */
export const queueSignature = (snapshot: Snapshot) =>
  `${masterList(snapshot).map((m) => `${m.id}:${m.status}`).join(',')}|${snapshot.requests.filter((r) => r.status !== 'played' && r.status !== 'failed' && r.status !== 'removed' && r.status !== 'skipped' && r.status !== 'archived').map((r) => r.id).join(',')}`;

// ----------------------------------------------------------------- errors

export type ErrorTone = 'conflict' | 'auth' | 'rejected' | 'transient';

/** Operator-facing explanation of a rejected command. `retryable` ones may be retried with the same ID. */
export function explainError(error: ApiError, type: string): { tone: ErrorTone; message: string } {
  switch (error.code) {
    case 'GUARD_MISMATCH':
      if (type === 'request.playNow') return { tone: 'conflict', message: 'Nothing changed: a request is already playing. Move this one to the top of the queue to play it next.' };
      return { tone: 'conflict', message: 'Nothing changed: the item you targeted is no longer playing — another organizer or the schedule moved on. Review the current state and decide again.' };
    case 'NOT_FOUND':
      return { tone: 'conflict', message: 'Nothing changed: that entry is already gone or no longer in this queue — someone else may have changed it.' };
    case 'REVISION_CONFLICT':
      return { tone: 'conflict', message: 'The state changed while you were deciding. Nothing was applied; review and confirm again.' };
    case 'NIGHT_ALREADY_OPEN':
      return { tone: 'conflict', message: 'A night is already open (another organizer may have just opened it).' };
    case 'NIGHT_CLOSED':
      return { tone: 'conflict', message: 'No night is open (another organizer may have just closed it).' };
    case 'UNAUTHENTICATED':
      return { tone: 'auth', message: 'Your session expired. Sign in again; this action was not applied.' };
    case 'FORBIDDEN':
      return { tone: 'auth', message: 'Your account is not allowed to do this. Organizer access is required.' };
    case 'SOURCE_UNSUPPORTED':
      // The service uses one code for several causes; tell them apart by the message it sends.
      if (/playlist|album/i.test(error.message)) return { tone: 'rejected', message: 'Playlists and albums cannot be imported yet: playlist import is not part of the contract. Add single YouTube track or mix links.' };
      if (/matching/i.test(error.message)) return { tone: 'rejected', message: 'Spotify and Apple Music links cannot be played yet: matching them to audio is not implemented. Add a YouTube link.' };
      return { tone: 'rejected', message: 'That link is not a supported source. Only single YouTube track or mix links work right now.' };
    case 'INVALID_SOURCE':
      return { tone: 'rejected', message: `${error.message} Playlists and albums cannot be imported yet; add single YouTube track or mix links.` };
    case 'NOT_READY':
      return { tone: 'conflict', message: 'That request is still loading. Try again in a moment.' };
    case 'NOTHING_PLAYABLE':
      return { tone: 'rejected', message: 'There is no playable master music. Add a master item and wait for it to become ready.' };
    case 'DURATION_REJECTED':
      return { tone: 'rejected', message: error.message };
    case 'SOURCE_UNAVAILABLE':
      return { tone: 'transient', message: `${error.message} Nothing was added.` };
    case 'LEASE_HELD':
    case 'INTERNAL':
      return { tone: 'transient', message: error.retryable ? `${error.message}. It is safe to retry; the same command ID is reused.` : error.message };
    default:
      return { tone: 'rejected', message: error.message };
  }
}

/** Local control feedback lasts until the authoritative snapshot catches up. Failures roll back. */
export function optimisticIntent(snapshot: Snapshot, intents: readonly Intent[], types: readonly string[]): Intent | null {
  const latest = intents.find((intent) => types.includes(intent.type));
  if (!latest || latest.status === 'failed') return null;
  if (latest.status === 'pending' || (latest.revision !== undefined && snapshot.revision < latest.revision)) return latest;
  // A newer revision may be a volume change; it must never resurrect an old seek preview.
  if (latest.type === 'playback.seek' && snapshot.revision === latest.revision && snapshot.playback.confirmation === 'requested') return latest;
  return null;
}
