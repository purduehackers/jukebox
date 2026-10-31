import type { Snapshot, ObservedStatus } from '../../../src/contract/types.ts';

export const fixtureStates = ['master', 'request', 'paused', 'buffering', 'offline', 'needs_activation', 'empty', 'closed', 'due_song', 'due_paused', 'disconnected', 'long_titles', 'many_requests'] as const;
export type FixtureState = typeof fixtureStates[number];
export function displayFixture(state: FixtureState, now = Date.now()): Snapshot {
  const snapshot: Snapshot = {
    contractVersion: 1, revision: 10, serverTime: now, role: 'public',
    night: { id: 'fixture-night', status: 'open', openedAt: now - 3600000, closedAt: null },
    schedule: { phase: 'master', intent: 'playing', periodStartedAt: now - 528000, periodMs: 900000, turnDue: false, dueReason: null },
    nowPlaying: { kind: 'master', entryId: 'fixture-master', title: 'NCS: 1 Hour Gaming Music Mix', artist: 'NoCopyrightSounds', durationSec: 3634 },
    nextMaster: { title: 'Next organizer track', artist: 'Master artist', durationSec: 240 },
    suspendedMaster: null,
    playback: { desiredEpoch: 1, ackedEpoch: 1, confirmation: 'confirmed', volume: 0.5,
      observed: { deviceId: 'fixture-device', status: 'playing', loadId: 1, ackedEpoch: 1, positionSec: 1421, observedAt: now, error: null } },
    requests: [
      { id: 'request1', title: 'A New Kind Of Love (pt. 1)', artist: 'Ghost Funk Orchestra', durationSec: 297, status: 'ready' },
      { id: 'request2', title: 'Invincible', artist: 'DEAF KEV', durationSec: 208, status: 'ready' },
      { id: 'request3', title: 'Preparing audio…', artist: null, durationSec: 180, status: 'preparing' },
    ], alerts: [],
  };
  if (['paused', 'buffering', 'offline', 'needs_activation'].includes(state)) snapshot.playback.observed!.status = state as ObservedStatus;
  if (state === 'paused') snapshot.schedule.intent = 'paused';
  if (state === 'request') {
    snapshot.schedule.phase = 'request';
    snapshot.nowPlaying = { kind: 'request', entryId: 'request1', title: 'A New Kind Of Love (pt. 1)', artist: 'Ghost Funk Orchestra', durationSec: 297 };
    snapshot.playback.observed!.positionSec = 45;
    snapshot.requests[0]!.status = 'playing';
    snapshot.suspendedMaster = { entryId: 'fixture-master', title: 'NCS: 1 Hour Gaming Music Mix', positionSec: 1421 };
    snapshot.nextMaster = { title: snapshot.suspendedMaster.title, artist: 'NoCopyrightSounds', durationSec: 3634 };
  }
  if (state === 'empty' || state === 'closed') {
    snapshot.nowPlaying = null; snapshot.requests = []; snapshot.nextMaster = null;
    snapshot.schedule.periodStartedAt = null; snapshot.playback.observed = null;
    if (state === 'closed') snapshot.night!.status = 'closed';
  }
  if (state === 'due_song' || state === 'due_paused') {
    snapshot.schedule.periodStartedAt = now - 901000; snapshot.schedule.turnDue = true;
    snapshot.schedule.dueReason = state === 'due_song' ? 'song_end' : 'paused';
    if (state === 'due_paused') { snapshot.schedule.intent = 'paused'; snapshot.playback.observed!.status = 'paused'; }
    else snapshot.nowPlaying!.durationSec = 360;
  }
  if (state === 'long_titles') {
    snapshot.nowPlaying!.title = 'An Unusually Long Master Mix Title — Extended Festival Recording From a Venue With an Extremely Long Name — Bonus Edition'.repeat(3);
    snapshot.nowPlaying!.artist = 'A very long list of artists and collaborators '.repeat(8);
    snapshot.requests[0]!.title = snapshot.nowPlaying!.title;
    snapshot.requests[0]!.artist = snapshot.nowPlaying!.artist;
    snapshot.nextMaster!.title = snapshot.nowPlaying!.title;
  }
  if (state === 'many_requests') snapshot.requests = Array.from({ length: 30 }, (_, i) => ({ ...snapshot.requests[0]!, id: `request${i}` }));
  return snapshot;
}
