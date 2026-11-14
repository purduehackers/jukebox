import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { OrganizerGate } from '../shared/OrganizerGate.tsx';
import { Player } from '../player/Player.tsx';
import type { Snapshot } from '../shared/api.ts';
import { useLightningColors } from '../shared/hooks.ts';
import type { LocalPlayback } from './model.ts';
import { displayModel, duration, safeArtwork } from './model.ts';
import { RequestQr } from './RequestQr.tsx';
import { Soundbar } from '../visual/Soundbar.tsx';
import { displaySettings } from '../visual/display-preset.ts';
import { displayFixture, fixtureStates, type FixtureState } from './fixtures.ts';
import '@fontsource/inconsolata/400.css';
import '@fontsource/inconsolata/700.css';
import './display.css';

/** Same live border gradient as the Hack Night dashboard clock. */
function NowPlayingBox({ children }: { children: ReactNode }) {
  const colors = useLightningColors();
  return (
    <section
      className="display-now"
      aria-label="Now playing"
      style={{
        borderImageSource: `linear-gradient(120deg in oklch, ${colors.boltColor}, ${colors.zapColor}, ${colors.sparkColor})`,
        borderImageSlice: 1,
      }}
    >
      {children}
    </section>
  );
}

function Artwork({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  const safe = safeArtwork(url);
  useEffect(() => setFailed(false), [safe]);
  return (
    <div className="display-artwork">
      {safe && !failed ? (
        <img src={safe} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <span>No artwork</span>
      )}
    </div>
  );
}

/** Read-only presentation; receives public state and never claims audio authority. */
export function DisplayView({
  snapshot,
  error,
  now,
  local,
}: {
  snapshot: Snapshot | null;
  error: string | null;
  now: number;
  local?: LocalPlayback | null;
}) {
  if (!snapshot || snapshot.night?.status !== 'open') {
    const idleState = snapshot ? 'idle' : 'connecting';
    const idleMsg = snapshot ? 'Night not started' : error ? 'Connecting to Jukebox…' : 'Waiting for the session…';
    return (
      <main className="display-idle" data-testid="display" data-state={idleState}>
        <div>
          <h1>JUKEBOX</h1>
          <p>{idleMsg}</p>
        </div>
      </main>
    );
  }
  const model = displayModel(snapshot, now, !!error, local);
  const track = snapshot.nowPlaying;
  const requester =
    track?.kind === 'request' ? snapshot.requests.find((entry) => entry.id === track.entryId)?.requester : undefined;
  const status = model.status.replaceAll('_', ' ');
  return (
    <main className="jukebox-display" data-testid="display" data-state={model.status}>
      <div className="display-left">
        <section className="display-visualizer" aria-label="Audio-reactive soundbar">
          <Soundbar settings={displaySettings} playing={local ? local.status === 'playing' : model.playing} />
        </section>
        <NowPlayingBox>
          <Artwork url={track?.artworkUrl} />
          <div className="display-metadata">
            <div className="display-kicker">
              <span className="display-kind" data-kind={track?.kind}>
                {track ? (track.kind === 'request' ? 'Request Queue' : 'Master Queue') : 'JUKEBOX'}
              </span>
              <span className="display-status" role="status">
                {status}
                {track && !model.confirmed ? ' · awaiting player confirmation' : ''}
              </span>
            </div>
            <h1 title={track?.title}>{track?.title ?? 'Waiting for music'}</h1>
            <p className="display-artist" title={track?.artist ?? ''}>
              {track?.artist || (track ? 'Artist unavailable' : 'Organizer controls playback from /admin')}
            </p>
            <div className="display-progress">
              <span>{duration(model.progress)}</span>
              <progress aria-label="Track progress" value={model.progress ?? 0} max={track?.durationSec || 1} />
              <span>{duration(track?.durationSec)}</span>
            </div>
          </div>
        </NowPlayingBox>
      </div>
      <aside className="display-sidebar" aria-label="Request queue">
        <div className="display-queue-panel">
          <h2 className="display-heading">QUEUE</h2>
          <section className="display-turn" aria-label={track?.kind === 'request' ? 'Now playing' : 'Next request'}>
            {track?.kind !== 'request' && <span>NEXT REQUEST</span>}
            {requester && <span className="display-requested-label">Requested by</span>}
            <strong>{requester ?? model.turn}</strong>
            {model.detail && <p>{model.detail}</p>}
          </section>
          <div>
            {error && (
              <p className="display-warning" role="alert">
                Connection lost · showing last known state
              </p>
            )}
            {!error && model.status === 'offline' && <p className="display-warning">Playback device offline</p>}
          </div>
          <div className="display-queue">
            <ol>
              {model.requests.slice(0, 4).map((entry, index) => (
                <li key={entry.id} data-playing={entry.status === 'playing' ? 'true' : undefined}>
                  <span className="display-number">{index + 1}</span>
                  <div>
                    <strong title={entry.title}>{entry.title}</strong>
                    <p title={entry.artist ?? ''}>
                      {entry.artist || 'Artist unavailable'}
                      {entry.status === 'preparing' ? ' · preparing audio' : ''}
                    </p>
                  </div>
                  <span>{duration(entry.durationSec)}</span>
                </li>
              ))}
            </ol>
            {model.requests.length === 0 && (
              <p className="display-empty">
                No requests waiting.
                <br />
                Scan below to add yours.
              </p>
            )}
            {model.requests.length > 4 && <p className="display-more">+ {model.requests.length - 4} more requests</p>}
          </div>
        </div>
        <RequestQr />
      </aside>
    </main>
  );
}

const FixtureView = import.meta.env.DEV
  ? lazy(() => import('./FixtureView.tsx').then((module) => ({ default: module.FixtureView })))
  : null;

export function DisplayPage() {
  const [fixtureParam] = useState(() =>
    import.meta.env.DEV && typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('displayFixture')
      : null,
  );
  if (FixtureView && fixtureParam !== null) {
    return (
      <Suspense fallback={<p>Loading dev snapshots…</p>}>
        <FixtureView initial={fixtureParam} />
      </Suspense>
    );
  }
  return (
    <OrganizerGate>
      <LiveDisplay />
    </OrganizerGate>
  );
}

function LiveDisplay() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalPlayback | null>(null);
  const [clock, setClock] = useState({ server: Date.now(), receipt: performance.now() });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (snapshot) {
      setClock({ server: snapshot.serverTime, receipt: performance.now() });
      setNow(snapshot.serverTime);
    }
  }, [snapshot]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(clock.server + performance.now() - clock.receipt), 250);
    return () => window.clearInterval(timer);
  }, [clock]);

  return (
    <>
      <DisplayView snapshot={snapshot} error={error} now={now} local={local} />
      <Player
        onSnapshot={setSnapshot}
        onError={setError}
        onState={(state) =>
          setLocal({
            status: state.status,
            positionSec: state.positionSec,
            loadId: state.loadId,
            epoch: state.epoch,
          })
        }
      />
    </>
  );
}

export function isFixtureState(value: string | null): value is FixtureState {
  return value !== null && (fixtureStates as readonly string[]).includes(value);
}

export { displayFixture, fixtureStates };
