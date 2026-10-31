// Pure presentation logic for the attendee page: wording for every contract error and
// request state, plus honest queue-timing estimates. No React, no network, so it is
// unit-tested directly and the page stays a thin view.
import type { ApiError, ErrorCode, RequestEntryView, RequestStatus, Snapshot } from '../../../src/contract/types.ts';

export function formatDuration(totalSec: number | null): string {
  if (totalSec === null || !Number.isFinite(totalSec)) return '–:––';
  const whole = Math.max(0, Math.round(totalSec));
  const minutes = Math.floor(whole / 60);
  const seconds = String(whole % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// ---- Errors ----

export type Tone = 'info' | 'warn' | 'error';

export interface ErrorCopy {
  title: string;
  body: string;
  tone: Tone;
  /** The same tap may be retried later (network, busy resolver, rate limit). */
  retry: boolean;
  /** The user needs to sign in again or ask an organizer; editing the link will not help. */
  blocksLink: boolean;
}

/** Exhaustive: adding a contract ErrorCode without wording here fails the type check. */
const ERROR_COPY: Record<ErrorCode, Omit<ErrorCopy, 'retry' | 'body'> & { body: string }> = {
  BAD_REQUEST: { title: 'That didn’t look right', body: 'Paste a single track link, then check it again.', tone: 'error', blocksLink: false },
  UNAUTHENTICATED: { title: 'Sign in first', body: 'Requests need your Purdue Hackers ID so the three-song limit is fair.', tone: 'warn', blocksLink: true },
  FORBIDDEN: { title: 'Not allowed', body: 'Your account can’t do that here.', tone: 'error', blocksLink: true },
  NOT_FOUND: { title: 'Not found', body: 'That item is gone. Refresh to see the current queue.', tone: 'warn', blocksLink: false },
  REVISION_CONFLICT: { title: 'The queue just changed', body: 'Check the link again and retry.', tone: 'warn', blocksLink: false },
  IDEMPOTENCY_MISMATCH: { title: 'Please try again', body: 'That tap was already used for something else. Check the link once more.', tone: 'warn', blocksLink: false },
  GUARD_MISMATCH: {
    title: 'That link changed',
    body: 'It now points to a different recording than the one you checked. Check it again to see what will play.',
    tone: 'warn',
    blocksLink: false,
  },
  NIGHT_CLOSED: { title: 'Requests are closed', body: 'There is no open night right now. Ask an organizer, or try again when one starts.', tone: 'info', blocksLink: true },
  NIGHT_ALREADY_OPEN: { title: 'Night already open', body: 'A night session is already open.', tone: 'info', blocksLink: true },
  QUOTA_EXCEEDED: { title: 'You’re out of requests', body: 'You’ve used all your requests for tonight. A new night starts with a fresh allowance.', tone: 'info', blocksLink: true },
  DUPLICATE_REQUEST: { title: 'Already in the queue', body: 'That recording is already waiting. Pick another song, or look for it in the list below.', tone: 'info', blocksLink: false },
  INVALID_SOURCE: { title: 'That link doesn’t work', body: 'Paste a full https link to one YouTube, Spotify, or Apple Music track.', tone: 'error', blocksLink: false },
  SOURCE_UNSUPPORTED: {
    title: 'Link type not supported',
    body: 'Playlists, albums, and other sites can’t be requested. Paste a single YouTube, Spotify, or Apple Music track.',
    tone: 'error',
    blocksLink: false,
  },
  SOURCE_UNAVAILABLE: {
    title: 'Couldn’t find playable audio',
    body: 'We couldn’t get audio for that link. It may be private, removed, or region-locked. Try another link.',
    tone: 'error',
    blocksLink: false,
  },
  DURATION_REJECTED: { title: 'Too long for a request', body: 'Requests must be shorter than 6 minutes. Long mixes are added by organizers.', tone: 'error', blocksLink: false },
  RATE_LIMITED: { title: 'Slow down a little', body: 'You’ve checked a lot of links in a minute. Wait a few seconds and try again.', tone: 'warn', blocksLink: false },
  LEASE_HELD: { title: 'Not available here', body: 'That action isn’t for this page.', tone: 'error', blocksLink: true },
  STALE_LEASE: { title: 'Not available here', body: 'That action isn’t for this page.', tone: 'error', blocksLink: true },
  DEVICE_REVOKED: { title: 'Not available here', body: 'That action isn’t for this page.', tone: 'error', blocksLink: true },
  PAIRING_INVALID: { title: 'Not available here', body: 'That action isn’t for this page.', tone: 'error', blocksLink: true },
  NOTHING_PLAYABLE: { title: 'Not available here', body: 'That action isn’t for this page.', tone: 'error', blocksLink: true },
  INTERNAL: { title: 'Something went wrong on our side', body: 'Nothing was added to your allowance. Try again in a moment.', tone: 'error', blocksLink: false },
};

export interface Candidate {
  url: string;
  title: string;
  channel: string;
  durationSec: number;
  notes: string[];
}

export interface Disambiguation {
  kind: 'ambiguous' | 'version_mismatch' | 'no_match';
  requested: { title: string; artist: string; durationSec: number } | null;
  candidates: Candidate[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Defensive: `details` comes over the wire, so only well-formed candidates are shown. */
export function readDisambiguation(details: ApiError['details']): Disambiguation | null {
  if (!details) return null;
  const kind = details.kind;
  if (kind !== 'ambiguous' && kind !== 'version_mismatch' && kind !== 'no_match') return null;
  const requested = isRecord(details.requested) &&
      typeof details.requested.title === 'string' && typeof details.requested.artist === 'string' && typeof details.requested.durationSec === 'number'
    ? { title: details.requested.title, artist: details.requested.artist, durationSec: details.requested.durationSec }
    : null;
  const candidates: Candidate[] = [];
  for (const raw of Array.isArray(details.candidates) ? details.candidates : []) {
    if (!isRecord(raw)) continue;
    if (typeof raw.url !== 'string' || typeof raw.title !== 'string' || typeof raw.channel !== 'string' || typeof raw.durationSec !== 'number') continue;
    if (!/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(raw.url)) continue;
    const notes = Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string').slice(0, 4) : [];
    candidates.push({ url: raw.url, title: raw.title, channel: raw.channel, durationSec: raw.durationSec, notes });
    if (candidates.length === 3) break;
  }
  return { kind, requested, candidates };
}

export function describeError(error: ApiError): ErrorCopy {
  const base = ERROR_COPY[error.code] ?? ERROR_COPY.INTERNAL;
  const disambiguation = error.code === 'SOURCE_UNAVAILABLE' ? readDisambiguation(error.details) : null;
  if (disambiguation) {
    const title = {
      ambiguous: 'More than one version matches',
      version_mismatch: 'We only found different versions',
      no_match: 'No confident match for that track',
    }[disambiguation.kind];
    // The server's message is specific and user-safe for matching failures.
    return { title, body: error.message, tone: 'warn', retry: false, blocksLink: false };
  }
  // Server wording is more specific for validation failures; fall back to ours for generic ones.
  const useServerMessage = error.code === 'INVALID_SOURCE' || error.code === 'SOURCE_UNSUPPORTED' || error.code === 'SOURCE_UNAVAILABLE';
  const body = useServerMessage && error.message ? `${base.body} (${error.message})` : base.body;
  return { ...base, body, retry: error.retryable };
}

// ---- Request states ----

export interface StatusCopy {
  label: string;
  detail: string;
  tone: 'wait' | 'live' | 'done' | 'problem';
  /** Does this request still count toward the allowance, from the attendee's point of view? */
  allowance: 'counts' | 'refunded' | 'counts-final';
}

export const STATUS_COPY: Record<RequestStatus, StatusCopy> = {
  preparing: { label: 'Getting ready', detail: 'Fetching the audio. If it isn’t ready when a request turn arrives, it waits for the next one.', tone: 'wait', allowance: 'counts' },
  ready: { label: 'In line', detail: 'Ready to play on a request turn.', tone: 'wait', allowance: 'counts' },
  playing: { label: 'Playing now', detail: 'It’s on the speakers.', tone: 'live', allowance: 'counts-final' },
  played: { label: 'Played', detail: 'Thanks for the pick.', tone: 'done', allowance: 'counts-final' },
  failed: { label: 'Couldn’t play', detail: 'A technical problem stopped it. This one was refunded to your allowance.', tone: 'problem', allowance: 'refunded' },
  removed: { label: 'Removed by an organizer', detail: 'An organizer took it out of the queue. It still counts toward your three for tonight.', tone: 'problem', allowance: 'counts-final' },
  skipped: { label: 'Skipped by an organizer', detail: 'An organizer skipped it while it was playing. It still counts toward your three for tonight.', tone: 'problem', allowance: 'counts-final' },
  archived: { label: 'Night ended first', detail: 'The night ended before its turn. Allowances start fresh each night.', tone: 'problem', allowance: 'counts-final' },
};

export const WAITING: ReadonlySet<RequestStatus> = new Set<RequestStatus>(['preparing', 'ready']);

// ---- Timing ----

export type TurnEstimate =
  | { kind: 'closed' }
  | { kind: 'playing' }
  | { kind: 'not-waiting' }
  /** Master music has not started tonight, so the 15-minute request clock is not running. */
  | { kind: 'clock-not-started'; ahead: number }
  /** A turn is due but held: paused, player offline, or the current song is finishing. */
  | { kind: 'turn-due'; ahead: number; reason: 'song_end' | 'paused' | 'offline' | null }
  | { kind: 'waiting'; ahead: number; approxMinutes: number };

const MIN = 60_000;

/**
 * A rough, explicitly non-guaranteed estimate. It assumes nothing ahead of the entry changes
 * (admins can remove or reorder; a request still preparing at its turn is passed over) and
 * ignores how much of the current master song is left.
 */
export function estimateTurn(snapshot: Pick<Snapshot, 'night' | 'schedule' | 'requests'>, entryId: string, nowServer: number): TurnEstimate {
  if (!snapshot.night || snapshot.night.status !== 'open') return { kind: 'closed' };
  const lineup = snapshot.requests.filter((r) => r.status === 'playing' || WAITING.has(r.status));
  const index = lineup.findIndex((r) => r.id === entryId);
  if (index < 0) return { kind: 'not-waiting' };
  if (lineup[index]!.status === 'playing') return { kind: 'playing' };
  // The playing request is not "ahead" of anyone's wait for the *next* turn.
  const waiting = lineup.filter((r) => WAITING.has(r.status));
  const ahead = waiting.findIndex((r) => r.id === entryId);
  const { schedule } = snapshot;
  if (schedule.phase === 'request') {
    // A request is playing: the next turn starts a fresh master period after it ends.
    const playingLeft = lineup.find((r) => r.status === 'playing');
    const playing = playingLeft?.durationSec ?? 0;
    const approx = (playing * 1000 + schedule.periodMs + durationAhead(waiting, ahead, schedule.periodMs)) / MIN;
    return { kind: 'waiting', ahead, approxMinutes: roundUpToFive(approx) };
  }
  if (schedule.turnDue) return { kind: 'turn-due', ahead, reason: schedule.dueReason };
  if (schedule.periodStartedAt === null) return { kind: 'clock-not-started', ahead };
  const untilTurn = Math.max(0, schedule.periodStartedAt + schedule.periodMs - nowServer);
  return { kind: 'waiting', ahead, approxMinutes: roundUpToFive((untilTurn + durationAhead(waiting, ahead, schedule.periodMs)) / MIN) };
}

/** Each request ahead costs its own length plus the 15-minute master period that follows it. */
function durationAhead(waiting: RequestEntryView[], ahead: number, periodMs: number): number {
  let total = 0;
  for (const entry of waiting.slice(0, ahead)) total += (entry.durationSec ?? 0) * 1000 + periodMs;
  return total;
}

function roundUpToFive(minutes: number): number {
  return Math.max(0, Math.ceil(minutes / 5) * 5);
}

export function describeEstimate(estimate: TurnEstimate): string {
  switch (estimate.kind) {
    case 'closed': return 'This night has ended.';
    case 'playing': return 'Playing now.';
    case 'not-waiting': return '';
    case 'clock-not-started': return 'Request turns begin about 15 minutes after the organizers start the music.';
    case 'turn-due': {
      const why = estimate.reason === 'paused'
        ? 'Music is paused, so it will wait for an organizer to resume.'
        : estimate.reason === 'offline'
        ? 'The venue player is offline right now.'
        : 'It starts as soon as the current song ends.';
      return estimate.ahead === 0 ? `A request turn is due. ${why}` : `A request turn is due, with ${plural(estimate.ahead, 'request')} ahead of you. ${why}`;
    }
    case 'waiting': {
      const place = estimate.ahead === 0 ? 'You’re next' : `${plural(estimate.ahead, 'request')} ahead of you`;
      const when = estimate.approxMinutes <= 5 ? 'within about 5 minutes' : `in roughly ${estimate.approxMinutes} minutes`;
      return `${place}. Estimated ${when}; it can come sooner or later if the queue changes.`;
    }
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
