// Phase 4A: organizer controls at /admin. Composition only: data in state.ts, rules in derive.ts,
// command identity in intents.ts, markup in views.tsx.
import { useMemo, useState } from 'react';
import './admin.css';
import { AccessGate, ActivityPanel, AlertsBand, DevicesPanel, Header, MasterQueuePanel, NightPanel, NowPlayingPanel, RequestQueuePanel, TurnPanel } from './views.tsx';
import type { Actions } from './views.tsx';
import { useControls, useLive, useServerNow, useTicker } from './state.ts';

export function AdminPage() {
  const live = useLive();
  const controls = useControls(live);
  const { runner, volume, intents } = controls;
  const [pendingVolume, setPendingVolume] = useState<number | null>(null);
  const [pairing, setPairing] = useState<{ name: string; code: string; expiresAt: number } | null>(null);
  volume.onPending = setPendingVolume;
  const localNow = useTicker(1000);
  const serverNow = useServerNow(live, localNow);

  const actions = useMemo<Actions>(() => ({
    play: () => runner.run('Play', 'playback.play', {}),
    pause: () => runner.run('Pause', 'playback.pause', {}),
    skip: (entryId) => runner.run('Skip current item', 'playback.skip', { entryId }),
    replay: (entryId) => runner.run('Replay from start', 'playback.seek', { entryId, positionSec: 0 }),
    seek: (entryId, positionSec) => runner.run(`Seek to ${Math.floor(positionSec / 60)}:${String(Math.floor(positionSec % 60)).padStart(2, '0')}`, 'playback.seek', { entryId, positionSec }),
    setVolume: (v) => volume.set(v),
    openNight: () => runner.run('Open night', 'night.open', {}),
    // Strict CAS: if anything changed while the organizer was confirming, nothing is closed.
    closeNight: (expectedRevision) => runner.run('Close night', 'night.close', {}, { expectedRevision }),
    addMaster: (url) => runner.run(`Add master item ${url}`, 'master.add', { url }),
    removeMaster: (entryId, title) => runner.run(`Remove master “${title}”`, 'master.remove', { entryId }),
    moveMaster: (entryId, afterEntryId, title) => runner.run(`Reorder master “${title}”`, 'master.move', { entryId, afterEntryId }),
    removeRequest: (entryId, title) => runner.run(`Remove request “${title}”`, 'request.remove', { entryId }),
    moveRequest: (entryId, afterEntryId, title) => runner.run(`Reorder request “${title}”`, 'request.move', { entryId, afterEntryId }),
    createPairing: async (name) => {
      const intent = await runner.run(`Create pairing code for ${name}`, 'device.pairing.create', { name });
      const result = intent.result as { code: string; expiresAt: number } | undefined;
      if (intent.status === 'ok' && result) setPairing({ name, code: result.code, expiresAt: result.expiresAt });
      return intent;
    },
    revokeDevice: (deviceId, name) => runner.run(`Revoke device “${name}”`, 'device.revoke', { deviceId }),
    retry: (id) => void runner.retry(id),
    dismiss: (id) => runner.dismiss(id),
  }), [runner, volume]);

  if (live.access.state !== 'admin' || !live.snapshot) {
    if (live.access.state === 'admin') return <main className="jb-panel adm-gate" aria-busy="true"><p>Loading jukebox state…</p></main>;
    return <AccessGate access={live.access} onRetry={live.recheck} />;
  }
  const snapshot = live.snapshot;
  const lastAdd = intents.find((i) => i.type === 'master.add') ?? null;
  const signOut = async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
    live.recheck();
  };

  return (
    <div className="adm-root">
      <Header name={live.access.name} link={live.link} linkError={live.linkError} onSignOut={() => void signOut()} />
      <AlertsBand snapshot={snapshot} link={live.link} external={live.externalChange} onAckExternal={live.ackExternal} />
      <div className="adm-grid">
        <div className="adm-col">
          <NowPlayingPanel snapshot={snapshot} serverNow={serverNow} actions={actions} pendingVolume={pendingVolume} />
          <TurnPanel snapshot={snapshot} serverNow={serverNow} />
          <NightPanel snapshot={snapshot} actions={actions} />
        </div>
        <div className="adm-col">
          <RequestQueuePanel snapshot={snapshot} actions={actions} />
          <MasterQueuePanel snapshot={snapshot} actions={actions} lastAdd={lastAdd} />
        </div>
        <div className="adm-col">
          <DevicesPanel devices={snapshot.devices ?? []} pairing={pairing} actions={actions} />
          <ActivityPanel intents={intents} actions={actions} />
        </div>
      </div>
    </div>
  );
}
