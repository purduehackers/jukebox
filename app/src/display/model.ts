import { POLICY } from '../../../src/contract/types.ts';
import type { Snapshot } from '../../../src/contract/types.ts';

export function duration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}

/** Presentation only: the service owns all turn transitions, including empty turns. */
export function displayModel(snapshot: Snapshot | null, now: number, disconnected = false) {
  const observed = snapshot?.playback.observed;
  const stale = observed?.observedAt == null || now - observed.observedAt > POLICY.leaseMs;
  const confirmed = snapshot?.playback.confirmation === 'confirmed';
  const status = disconnected ? 'disconnected' : !snapshot ? 'connecting' : !snapshot.nowPlaying ? 'empty'
    : stale ? 'offline' : observed!.status === 'playing' && !confirmed ? 'waiting_for_player' : observed!.status;
  const playing = status === 'playing' && confirmed;
  const position = observed?.positionSec;
  const elapsed = playing ? Math.max(0, now - observed!.observedAt!) / 1000 : 0;
  const progress = !confirmed || position == null ? null : Math.min(snapshot?.nowPlaying?.durationSec ?? Infinity, Math.max(0, position + elapsed));
  let turn = 'Waiting for master playback';
  let detail = 'One request per turn';
  if (snapshot?.night?.status !== 'open') turn = snapshot ? 'Requests closed' : 'Connecting…';
  else if (snapshot.schedule.mode === 'master') {
    turn = 'Master music'; detail = 'Request turns are off';
  } else if (snapshot.schedule.mode === 'requests') {
    turn = snapshot.schedule.requestsIdle ? 'Waiting for requests' : 'Requests only'; detail = 'Requests play one after another';
  } else if (snapshot.schedule.phase === 'request') {
    turn = 'Request turn'; detail = `Then ${Math.round(snapshot.schedule.periodMs / 60_000)} minutes of master music`;
  } else if (snapshot.schedule.periodStartedAt != null) {
    const remaining = Math.max(0, snapshot.schedule.periodMs - (now - snapshot.schedule.periodStartedAt));
    turn = remaining > 0 ? `in ${duration(Math.ceil(remaining / 1000))}` : 'Turn due';
    detail = snapshot.schedule.dueReason === 'song_end' ? 'After this master song finishes'
      : snapshot.schedule.dueReason === 'paused' ? 'Waiting for organizer to resume'
      : snapshot.schedule.dueReason === 'offline' ? 'Waiting for playback device'
      : remaining === 0 ? 'Awaiting scheduler confirmation'
      : (snapshot.nowPlaying?.durationSec ?? 0) > POLICY.mixThresholdSec ? '' : 'Master song will finish first';
  }
  return { status, confirmed, playing, progress, turn, detail,
    requests: snapshot?.requests.filter((entry) => entry.status === 'ready' || entry.status === 'preparing') ?? [] };
}

export function requestUrl(configuredOrigin: string | undefined, actualOrigin: string) {
  const url = new URL(configuredOrigin || actualOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Request origin must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  return new URL('/queue', url.origin).href;
}

export function safeArtwork(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
}
