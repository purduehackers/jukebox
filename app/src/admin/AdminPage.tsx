// Phase 4A: organizer controls at /admin. Composition only: data in state.ts, rules in derive.ts,
// command identity in intents.ts, markup in views.tsx.
import { useEffect, useMemo, useState } from 'react';
import './admin.css';
import { AccessGate, ActivityPanel, AddBar, AlertsBand, Header, MasterQueuePanel, NightPanel, NowPlayingPanel, QueueControls, RequestQueuePanel, TurnPanel } from './views.tsx';
import type { Actions } from './views.tsx';
import { useControls, useLive, useServerNow, useTicker } from './state.ts';

export function AdminPage() {
  const live = useLive();
  const controls = useControls(live);
  const { runner, volume, intents } = controls;
  const [showActivity, setShowActivity] = useState(false);
  const [pendingVolume, setPendingVolume] = useState<number | null>(null);
  useEffect(() => {
    volume.onPending = setPendingVolume;
    return () => { volume.onPending = () => undefined; };
  }, [volume]);
  const localNow = useTicker(1000);
  const serverNow = useServerNow(live, localNow);

  const actions = useMemo<Actions>(() => ({
    play: () => runner.run('Play', 'playback.play', {}),
    pause: () => runner.run('Pause', 'playback.pause', {}),
    skip: (entryId) => runner.run('Skip', 'playback.skip', { entryId }),
    replay: (entryId) => runner.run('Restart song', 'playback.seek', { entryId, positionSec: 0 }),
    seek: (entryId, positionSec) => runner.run(`Seek to ${Math.floor(positionSec / 60)}:${String(Math.floor(positionSec % 60)).padStart(2, '0')}`, 'playback.seek', { entryId, positionSec }),
    setVolume: (v) => volume.set(v),
    beginVolume: () => volume.begin(),
    commitVolume: () => volume.flush(),
    openNight: () => runner.run('Start night', 'night.open', {}),
    // Strict CAS: if anything changed while the organizer was confirming, nothing is closed.
    closeNight: (expectedRevision) => runner.run('End night', 'night.close', {}, { expectedRevision }),
    addMaster: (url) => runner.run(`Add to master: ${url}`, 'master.add', { url }),
    addRequest: (url) => runner.run(`Add to requests: ${url}`, 'request.submit', { url }),
    removeMaster: (entryId, title) => runner.run(`Remove “${title}” from master`, 'master.remove', { entryId }),
    moveMaster: (entryId, afterEntryId, title) => runner.run(`Move “${title}”`, 'master.move', { entryId, afterEntryId }),
    setMode: (mode) => runner.run(`Play from: ${{ auto: 'Auto', master: 'Master only', requests: 'Requests only' }[mode]}`, 'queue.mode', { mode }),
    setInterval: (periodMs) => runner.run(periodMs === null ? 'Use the default request interval' : `Request every ${periodMs / 60_000} min`, 'queue.interval', { periodMs }),
    playNow: (entryId, title) => runner.run(`Play “${title}” now`, 'request.playNow', { entryId }),
    removeRequest: (entryId, title) => runner.run(`Remove request “${title}”`, 'request.remove', { entryId }),
    moveRequest: (entryId, afterEntryId, title) => runner.run(`Move request “${title}”`, 'request.move', { entryId, afterEntryId }),
    retry: (id) => void runner.retry(id),
  }), [runner, volume]);

  if (live.access.state !== 'admin' || !live.snapshot) {
    if (live.access.state === 'admin') return <main className="jb-panel adm-gate" aria-busy="true"><p>Loading…</p></main>;
    return <AccessGate access={live.access} onRetry={live.recheck} />;
  }
  const snapshot = live.snapshot;
  const lastAdd = intents.find((i) => i.type === 'master.add' || i.type === 'request.submit') ?? null;
  const signOut = async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
    live.recheck();
  };

  return (
    <div className="adm-root">
      <Header name={live.access.name} link={live.link} linkError={live.linkError} onSignOut={() => void signOut()}>
        <NightPanel snapshot={snapshot} actions={actions} />
        <button type="button" className="adm-btn" aria-expanded={showActivity} aria-controls="adm-activity" onClick={() => setShowActivity((shown) => !shown)}>
          {showActivity ? 'Hide activity log' : 'Show activity log'}
        </button>
      </Header>
      <AlertsBand snapshot={snapshot} link={live.link} external={live.externalChange} onAckExternal={live.ackExternal} />
      <NowPlayingPanel snapshot={snapshot} serverNow={serverNow} actions={actions} pendingVolume={pendingVolume} intents={intents}>
        <TurnPanel snapshot={snapshot} serverNow={serverNow} />
        <QueueControls snapshot={snapshot} serverNow={serverNow} actions={actions} intents={intents} />
      </NowPlayingPanel>
      <AddBar actions={actions} lastAdd={lastAdd} nightOpen={snapshot.night?.status === 'open'} />
      <div className="adm-queues">
        <MasterQueuePanel snapshot={snapshot} actions={actions} />
        <RequestQueuePanel snapshot={snapshot} actions={actions} />
      </div>
      <ActivityPanel intents={intents} actions={actions} hidden={!showActivity} />
    </div>
  );
}
