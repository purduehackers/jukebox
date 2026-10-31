// Pure view-model helpers for /admin. No React, no I/O: unit-tested against the real service.
import type { ApiError, MasterEntryView, RequestEntryView, Snapshot } from '../../../src/contract/types.ts';
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
  no_display: 'No display connected',
  offline: 'Display offline',
  needs_activation: 'Display needs activation',
  loading: 'Display loading',
  buffering: 'Display buffering',
  playing: 'Display playing',
  paused: 'Display paused',
  ended: 'Display track ended',
  error: 'Display error',
};

export type Confirmation = Snapshot['playback']['confirmation'];

/** Plain-language distinction between accepted, acknowledged by the player, and unacknowledged. */
export const CONFIRMATION_LABEL: Record<Confirmation, { label: string; detail: string }> = {
  none: { label: 'Nothing to confirm', detail: 'Nothing is loaded for the display.' },
  requested: { label: 'Requested', detail: 'The server accepted this change; the display has not confirmed it yet.' },
  confirmed: { label: 'Confirmed by display', detail: 'The display acknowledged the latest change. This does not prove the room can hear it.' },
  unconfirmed: { label: 'Unconfirmed', detail: `No acknowledgement from the display for over ${POLICY.ackTimeoutMs / 1000} s. The change may not have happened.` },
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
 * extrapolated from its report time; anything not confirmed or offline is labelled, not hidden.
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
  else if (snapshot.playback.confirmation !== 'confirmed') basis = 'unconfirmed';
  else if (observed.status === 'playing') {
    position += Math.max(0, serverNow - observed.observedAt) / 1000;
    basis = 'live';
  } else basis = 'reported';
  if (duration !== null) position = Math.min(position, duration);
  return { positionSec: position, durationSec: duration, remainingSec: duration === null ? null : Math.max(0, duration - position), basis };
}

// ------------------------------------------------------------ request turn

export type TurnKind = 'night_closed' | 'in_request' | 'not_started' | 'counting' | 'due' | 'elapsed_empty';

export interface TurnView {
  kind: TurnKind;
  headline: string;
  detail: string;
  /** Remaining time of the master period; null when it is not running. Never an ETA for the request. */
  periodRemainingMs: number | null;
  readyRequests: number;
  preparingRequests: number;
}

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
    return { ...base, kind: 'night_closed', headline: 'No request turns', detail: 'Requests are closed until a night is opened. Master music can still play.' };
  }
  if (schedule.phase === 'request') {
    return { ...base, kind: 'in_request', headline: 'A request is playing', detail: 'When it ends, the suspended master resumes and a fresh 15-minute master period starts.' };
  }
  if (schedule.periodStartedAt === null) {
    return { ...base, kind: 'not_started', headline: 'Timer not started', detail: 'The master period starts at the first Play of this night.' };
  }
  const remaining = schedule.periodStartedAt + schedule.periodMs - serverNow;
  const where = [
    schedule.intent === 'paused' ? 'Playback is paused — the timer keeps running.' : null,
    snapshot.playback.observed?.status === 'offline' ? 'The display is offline — turns are decided by the server and apply when it reconnects.' : null,
  ].filter(Boolean).join(' ');
  if (schedule.turnDue) {
    const reason = {
      song_end: 'Waiting for the current master song to finish; it is not interrupted.',
      paused: 'Waiting for an organizer to press Play. A mix is interrupted at once; a normal song finishes first.',
      offline: 'The display is offline; the request starts when it reconnects.',
    }[schedule.dueReason ?? 'song_end'];
    return { ...base, kind: 'due', headline: 'Request turn is due', detail: reason };
  }
  if (remaining <= 0) {
    return { ...base, kind: 'elapsed_empty', headline: 'Period elapsed, no ready request', detail: `The turn is empty, so the 15-minute period restarts now. ${preparing ? `${preparing} still preparing do not count.` : ''}`.trim() };
  }
  const current = snapshot.master?.find((m) => m.id === snapshot.nowPlaying?.entryId);
  const interrupt = current?.isMix
    ? 'The current item is a mix, so a ready request interrupts it when the period ends.'
    : 'A normal song finishes before the request starts.';
  const consequence = ready
    ? `${ready} ready request${ready === 1 ? '' : 's'} will take this turn.`
    : 'No ready request yet: if none is ready when the period ends, the turn is empty and the period restarts.';
  return {
    ...base,
    kind: 'counting',
    periodRemainingMs: remaining,
    headline: `Master period ends in ${formatClock(remaining)}`,
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
      return { tone: 'rejected', message: type === 'master.add' ? 'Spotify and Apple Music links cannot be played yet: matching them to audio is not implemented. Add a YouTube link.' : error.message };
    case 'INVALID_SOURCE':
      return { tone: 'rejected', message: `${error.message} Playlists and albums cannot be imported yet; add single YouTube track or mix links.` };
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
