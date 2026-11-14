import { POLICY } from '../../../src/contract/types.ts';
import type { ObservedStatus, Snapshot } from '../../../src/contract/types.ts';

export function duration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}

export interface LocalPlayback {
  loadId: number | null;
  epoch: number;
  status: ObservedStatus;
  positionSec: number | null;
}

/** Presentation only: the service owns all turn transitions, including empty turns. */
export function displayModel(snapshot: Snapshot | null, now: number, disconnected = false, local?: LocalPlayback | null) {
  const own = local && snapshot?.desired && local.loadId === snapshot.desired.loadId
    && local.epoch === snapshot.desired.epoch && local.status !== 'loading';
  // Shared reports belong to any connected display. The local audio element is
  // the source of truth for this screen's progress, status and analysis.
  const observed = own ? { status: local.status, positionSec: local.positionSec, observedAt: now }
    : snapshot?.playback.observed;
  const stale = observed?.observedAt == null || now - observed.observedAt > POLICY.leaseMs;
  const confirmed = !!own || snapshot?.playback.confirmation === 'confirmed';
  const status = disconnected ? 'disconnected' : !snapshot ? 'connecting' : !snapshot.nowPlaying ? 'empty'
    : stale ? 'offline' : observed!.status === 'playing' && !confirmed ? 'waiting_for_player' : observed!.status;
  const playing = status === 'playing' && confirmed;
  const position = observed?.positionSec;
  const elapsed = playing ? Math.max(0, now - observed!.observedAt!) / 1000 : 0;
  const progress = !confirmed || position == null ? null : Math.min(snapshot?.nowPlaying?.durationSec ?? Infinity, Math.max(0, position + elapsed));
  let turn = 'Waiting for master playback';
  let detail = '';
  if (snapshot?.night?.status !== 'open') turn = snapshot ? 'Requests closed' : 'Connecting…';
  else if (snapshot.nowPlaying?.kind === 'request') {
    turn = 'Now Playing';
  } else if (snapshot.schedule.mode === 'master') {
    turn = 'Master music'; detail = 'Request turns are off';
  } else if (snapshot.schedule.mode === 'requests') {
    turn = snapshot.schedule.requestsIdle ? 'Waiting for requests' : 'Requests only';
  } else if (snapshot.schedule.phase === 'request') {
    turn = 'Now Playing';
  } else if (snapshot.schedule.periodStartedAt != null) {
    const remaining = Math.max(0, snapshot.schedule.periodMs - ((snapshot.schedule.periodPausedAt ?? now) - snapshot.schedule.periodStartedAt));
    turn = snapshot.schedule.periodPausedAt != null ? `Paused · ${duration(Math.ceil(remaining / 1000))}` : remaining > 0 ? `in ${duration(Math.ceil(remaining / 1000))}` : 'Turn due';
    detail = snapshot.schedule.dueReason === 'paused' ? 'Waiting for organizer to resume'
      : snapshot.schedule.dueReason === 'offline' ? 'Waiting for playback device'
      : '';
  }
  return { status, confirmed, playing, progress, turn, detail, observed,
    requests: snapshot?.requests.filter((entry) => entry.status === 'playing' || entry.status === 'ready' || entry.status === 'preparing').sort((a, b) => Number(b.status === 'playing') - Number(a.status === 'playing')) ?? [] };
}

export function requestUrl(configuredOrigin: string | undefined, actualOrigin: string) {
  const url = new URL(configuredOrigin || actualOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Request origin must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  return new URL('/', url.origin).href;
}

export function safeArtwork(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
}
