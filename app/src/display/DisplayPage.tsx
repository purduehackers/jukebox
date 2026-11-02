import { lazy, Suspense, useEffect, useState } from 'react';
import { Player } from '../player/Player.tsx';
import { useSnapshot } from '../shared/api.ts';
import type { Snapshot } from '../shared/api.ts';
import { displayModel, duration, safeArtwork } from './model.ts';
import { RequestQr } from './RequestQr.tsx';
import { Visualizer } from './Visualizer.tsx';
import '@fontsource/inconsolata/400.css';
import '@fontsource/inconsolata/700.css';
import './display.css';

function Artwork({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  const safe = safeArtwork(url);
  useEffect(() => setFailed(false), [safe]);
  return <div className="display-artwork">
    {safe && !failed ? <img src={safe} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span>No artwork</span>}
  </div>;
}

/** Read-only presentation; receives public state and never claims audio authority. */
export function DisplayView({ snapshot, error, now }: { snapshot: Snapshot | null; error: string | null; now: number }) {
  if (!snapshot || snapshot.night?.status !== 'open') return <main className="display-idle" data-testid="display" data-state={snapshot ? 'idle' : 'connecting'}>
    <div><h1>JUKEBOX</h1><p>{snapshot ? 'An admin needs to start a session.' : error ? 'Connecting to Jukebox…' : 'Waiting for the session…'}</p></div>
  </main>;
  const model = displayModel(snapshot, now, !!error);
  const track = snapshot?.nowPlaying;
  const observed = snapshot?.playback.observed;
  const status = model.status.replaceAll('_', ' ');
  return <main className="jukebox-display" data-testid="display" data-state={model.status}>
    <div className="display-left">
      <Visualizer playing={model.playing} trackKey={track?.entryId ?? ''} position={observed?.positionSec ?? null} observedAt={observed?.observedAt ?? null} />
      <section className="display-now" aria-label="Now playing">
        <Artwork url={track?.artworkUrl} />
        <div className="display-metadata">
          <div className="display-kicker"><span className="display-kind">{track ? track.kind === 'request' ? 'REQUEST' : `MASTER${(track.durationSec ?? 0) > 360 ? ' · MIX' : ''}` : 'JUKEBOX'}</span>
            <span className="display-status" role="status">{status}{track && !model.confirmed ? ' · awaiting player confirmation' : ''}</span></div>
          <h1 title={track?.title}>{track?.title ?? (snapshot ? 'Waiting for music' : 'Connecting to Jukebox…')}</h1>
          <p className="display-artist" title={track?.artist ?? ''}>{track?.artist || (track ? 'Artist unavailable' : 'Organizer controls playback from /admin')}</p>
          <div className="display-progress"><span>{duration(model.progress)}</span>
            <progress aria-label="Track progress" value={model.progress ?? 0} max={track?.durationSec || 1} />
            <span>{duration(track?.durationSec)}</span></div>
        </div>
      </section>
    </div>
    <aside className="display-sidebar" aria-label="Request queue">
      <div className="display-queue-panel">
      <h2 className="display-heading">QUEUE</h2>
      <section className="display-turn" aria-label="Next request turn"><span>NEXT REQUEST TURN</span><strong>{model.turn}</strong>{model.detail && <p>{model.detail}</p>}</section>
      {error && <p className="display-warning" role="alert">Connection lost · showing last known state</p>}
      {!error && model.status === 'offline' && <p className="display-warning">Playback device offline</p>}
      <div className="display-queue">
        <ol>{model.requests.slice(0, 4).map((entry, index) => <li key={entry.id}>
          <span className="display-number">{index + 1}</span><div><strong title={entry.title}>{entry.title}</strong><p title={entry.artist ?? ''}>{entry.artist || 'Artist unavailable'}{entry.status === 'preparing' ? ' · preparing audio' : ''}</p></div><span>{duration(entry.durationSec)}</span>
        </li>)}</ol>
        {model.requests.length === 0 && <p className="display-empty">No requests waiting.<br />Scan below to add yours.</p>}
        {model.requests.length > 4 && <p className="display-more">+ {model.requests.length - 4} more requests</p>}
      </div>
      </div>
      <RequestQr />
    </aside>
  </main>;
}

const FixtureView = import.meta.env.DEV ? lazy(() => import('./FixtureView.tsx').then((module) => ({ default: module.FixtureView }))) : null;

export function DisplayPage() {
  if (FixtureView && new URLSearchParams(location.search).has('displayFixture')) return <Suspense fallback={<p>Loading dev snapshots…</p>}><FixtureView /></Suspense>;
  return <LiveDisplay />;
}

function LiveDisplay() {
  const { snapshot, error } = useSnapshot();
  const [clock, setClock] = useState({ server: Date.now(), receipt: performance.now() });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (snapshot) {
      setClock({ server: snapshot.serverTime, receipt: performance.now() });
      setNow(snapshot.serverTime);
    }
  }, [snapshot]);
  useEffect(() => {
    const timer = setInterval(() => setNow(clock.server + performance.now() - clock.receipt), 250);
    return () => clearInterval(timer);
  }, [clock]);
  return <><DisplayView snapshot={snapshot} error={error} now={now} />
    <Player />
  </>;
}
