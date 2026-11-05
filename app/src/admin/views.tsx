// Presentational admin components. Props in, callbacks out: no fetching here, so every state
// (offline display, unconfirmed command, conflicts) can be rendered from a fixture snapshot.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { MasterEntryView, QueueMode, RequestEntryView, Snapshot } from '../../../src/contract/types.ts';
import { POLICY } from '../../../src/contract/types.ts';
import { PLAYER_LABEL, describeTurn, estimatePosition, explainError, formatClock, formatMinutes, moveAnchor, optimisticIntent, playerState, playingRequest, waitingRequests } from './derive.ts';
import type { Direction, PlayerState } from './derive.ts';
import type { Intent } from './intents.ts';
import type { Access, Link } from './state.ts';

export type Done = Promise<Intent>;

export interface Actions {
  play(): Done;
  pause(): Done;
  skip(entryId: string): Done;
  replay(entryId: string): Done;
  seek(entryId: string, positionSec: number): Done;
  setVolume(volume: number): void;
  beginVolume(): void;
  commitVolume(): void;
  openNight(): Done;
  closeNight(expectedRevision: number): Done;
  addMaster(url: string): Done;
  addRequest(url: string): Done;
  removeMaster(entryId: string, title: string): Done;
  moveMaster(entryId: string, afterEntryId: string | null, title: string): Done;
  setMode(mode: QueueMode): Done;
  setInterval(periodMs: number | null): Done;
  playNow(entryId: string, title: string): Done;
  removeRequest(entryId: string, title: string): Done;
  moveRequest(entryId: string, afterEntryId: string | null, title: string): Done;
  retry(intentId: string): void;
}

const time = (sec: number | null) => (sec === null ? '–:––' : formatClock(sec * 1000));
const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'dim';

function Panel({ title, id, children, aside, className = '' }: { title: string; id: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={`jb-panel adm-panel ${className}`} aria-labelledby={id}>
      <header className="adm-panel-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

const Tag = ({ tone, children }: { tone: Tone; children: ReactNode }) => <span className={`adm-tag adm-${tone}`}>{children}</span>;

/** Two-step button: the first press arms it, the second performs the action. */
export function ConfirmButton({ label, confirmLabel, warning, onConfirm, context, danger = true, disabled = false, className = '', title }: {
  label: string; confirmLabel: string; warning?: string; onConfirm: (armedContext: number | undefined) => void; context?: number; danger?: boolean; disabled?: boolean; className?: string; title?: string;
}) {
  const [armed, setArmed] = useState<{ context: number | undefined } | null>(null);
  if (!armed) return <button type="button" className={`adm-btn ${className}`} disabled={disabled} title={title} onClick={() => setArmed({ context })}>{label}</button>;
  return (
    <span className="adm-confirm" role="group" aria-label={`Confirm: ${label}`}>
      {warning ? <span className="adm-warning">{warning}</span> : null}
      <button type="button" className={`adm-btn ${danger ? 'adm-danger' : 'adm-primary'}`} onClick={() => { setArmed(null); onConfirm(armed.context); }}>{confirmLabel}</button>
      <button type="button" className="adm-btn" onClick={() => setArmed(null)}>Cancel</button>
    </span>
  );
}

// ------------------------------------------------------------------ access

export function AccessGate({ access, onRetry }: { access: Exclude<Access, { state: 'admin' }>; onRetry: () => void }) {
  if (access.state === 'loading') return <main className="jb-panel adm-gate" aria-busy="true"><p>Checking your sign-in…</p></main>;
  if (access.state === 'signed_out') {
    return (
      <main className="jb-panel adm-gate">
        <h1>{access.expired ? 'Session expired' : 'Organizer sign-in'}</h1>
        <p>{access.expired
          ? 'Your sign-in expired. Nothing you tried since then was applied. Sign in again to keep going.'
          : 'Sign in with Purdue Hackers ID. Only organizers can control the jukebox.'}</p>
        <a className="adm-btn adm-primary" href="/auth/login?returnTo=/admin">Sign in</a>
      </main>
    );
  }
  return (
    <main className="jb-panel adm-gate">
      <h1>Organizer access required</h1>
      <p>You are signed in as <strong>{access.name}</strong>, but this sign-in doesn’t include organizer access. If your PH ID access changed recently, check again to refresh it.</p>
      <a className="adm-btn adm-primary" href="/auth/login?returnTo=/admin">Check again</a>
      <a className="adm-btn" href="/auth/login?returnTo=/admin">Use a different account</a>
    </main>
  );
}

// --------------------------------------------------------- header + alerts

export function Header({ name, link, linkError, onSignOut, children }: { name: string; link: Link; linkError: string | null; onSignOut: () => void; children?: ReactNode }) {
  const tone = link === 'live' ? 'ok' : link === 'connecting' ? 'info' : 'bad';
  return (
    <header className="adm-header">
      <h1>Jukebox</h1>
      {children}
      <div className="adm-header-meta">
        <span className={`adm-link adm-${tone}`} title={linkError ?? undefined}>
          <span className="adm-dot" aria-hidden="true" />
          {link === 'live' ? 'Live' : link === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
        <span className="adm-dim">{name}</span>
        <button type="button" className="adm-btn adm-quiet" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}

export function AlertsBand({ snapshot, link, external, onAckExternal }: { snapshot: Snapshot; link: Link; external: boolean; onAckExternal: () => void }) {
  const items: ReactNode[] = [];
  if (link === 'reconnecting') items.push(<li key="link" className="adm-alert adm-bad">Connection to the jukebox service was lost. What you see may be out of date until it reconnects.</li>);
  for (const alert of snapshot.alerts) {
    if (alert.code === 'unconfirmed_command') continue; // Delayed inline indicator owns acknowledgement feedback.
    items.push(<li key={alert.code} className={`adm-alert ${alert.code === 'player_offline' ? 'adm-bad' : 'adm-warn'}`} data-alert={alert.code}>{alert.message}</li>);
  }
  if (external) {
    items.push(
      <li key="ext" className="adm-alert adm-info" data-alert="external_change">
        Someone else changed a queue. The lists are up to date.
        <button type="button" className="adm-btn adm-quiet" onClick={onAckExternal}>OK</button>
      </li>,
    );
  }
  if (!items.length) return null;
  return <ul className="adm-alerts" role="status" aria-live="polite">{items}</ul>;
}

// ------------------------------------------------------------------- night

export function NightPanel({ snapshot, actions }: { snapshot: Snapshot; actions: Actions }) {
  const open = snapshot.night?.status === 'open';
  const waiting = waitingRequests(snapshot).length;
  const playing = playingRequest(snapshot);
  return (
    <div className="adm-night" id="adm-night" data-open={open}>
      <span className="adm-night-state">
        <span className={`adm-dot adm-${open ? 'ok' : 'dim'}`} aria-hidden="true" />
        {open
          ? `Night open since ${clockTime(snapshot.night!.openedAt)} · requests on (${POLICY.quotaPerNight} each)`
          : 'Night not started'}
      </span>
      {open ? (
        <ConfirmButton
          label="End night…"
          confirmLabel="End night"
          context={snapshot.revision}
          warning={`Stops the music, closes requests, and clears ${waiting} waiting request${waiting === 1 ? '' : 's'}${playing ? ` and “${playing.title}”` : ''}. Nobody gets requests back.`}
          onConfirm={(revision) => void actions.closeNight(revision ?? snapshot.revision)}
        />
      ) : (
        <button type="button" className="adm-btn adm-primary" onClick={() => void actions.openNight()}>Start night</button>
      )}
    </div>
  );
}

// ------------------------------------------------------------- now playing

const STATE_TONE: Record<PlayerState, Tone> = { playing: 'ok', paused: 'dim', buffering: 'warn', loading: 'warn', needs_activation: 'warn', offline: 'bad', error: 'bad', no_display: 'bad', ended: 'dim' };

/** One line answering "is the room hearing what I asked for?", with the fix when it isn't. */
function displayStatus(snapshot: Snapshot, state: PlayerState): { tone: Tone; hint: string | null } {
  if (state === 'no_display') return { tone: 'bad', hint: 'Open /display on the laptop. It connects automatically.' };
  if (state === 'offline') return { tone: 'bad', hint: 'The display stopped reporting. Times shown are its last report.' };
  if (state === 'needs_activation') return { tone: 'warn', hint: 'Click “Enable sound” on the display.' };
  if (state === 'error') return { tone: 'bad', hint: snapshot.playback.observed?.error ?? null };
  return { tone: STATE_TONE[state], hint: null };
}

/** No feedback for normal round trips; the reserved icon appears only after a sustained delay. */
function DisplayWait({ waiting }: { waiting: boolean }) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    setDelayed(false);
    if (!waiting) return;
    const timer = setTimeout(() => setDelayed(true), 15_000);
    return () => clearTimeout(timer);
  }, [waiting]);
  return (
    <span className="adm-display-wait" role="status" hidden={!waiting || !delayed} title="Still waiting for the display. Check its connection.">
      <span className="adm-spinner" aria-hidden="true" />
      <span className="adm-sr">Still waiting for the display. Check its connection.</span>
    </span>
  );
}

export function NowPlayingPanel({ snapshot, serverNow, actions, pendingVolume, intents = [], children }: { intents?: readonly Intent[]; snapshot: Snapshot; serverNow: number; actions: Actions; pendingVolume: number | null; children?: ReactNode }) {
  const now = snapshot.nowPlaying;
  const state = playerState(snapshot);
  const { confirmation } = snapshot.playback;
  const position = estimatePosition(snapshot, serverNow);
  const transportIntent = optimisticIntent(snapshot, intents, ['playback.play', 'playback.pause']);
  const seekIntent = optimisticIntent(snapshot, intents, ['playback.seek']);
  const volumeIntent = optimisticIntent(snapshot, intents, ['playback.volume']);
  const playing = transportIntent ? transportIntent.type === 'playback.play' : snapshot.schedule.intent === 'playing';
  const seek = seekIntent?.payload as { entryId: string; positionSec: number } | undefined;
  const localPosition = seek?.entryId === now?.entryId ? seek?.positionSec : undefined;
  const [dragging, setDragging] = useState<number | null>(null);
  const shownPosition = dragging ?? localPosition ?? position.positionSec ?? 0;
  const volume = pendingVolume ?? (volumeIntent?.payload as { volume: number } | undefined)?.volume ?? snapshot.playback.volume;
  // A confirmation from a display that has since gone silent describes the past, not the present.
  const lapsed = confirmation === 'confirmed' && (state === 'offline' || state === 'no_display');
  const status = displayStatus(snapshot, state);
  const request = now?.kind === 'request' ? snapshot.requests.find((r) => r.id === now.entryId) : undefined;
  const caveat = position.basis === 'stale' ? 'last known' : null;
  const canSeek = !!now && position.positionSec !== null;
  const commitSeek = () => { if (now && dragging !== null) { void actions.seek(now.entryId, dragging); setDragging(null); } };

  return (
    <section className="adm-section" aria-labelledby="adm-now">
      <h2 id="adm-now" className="adm-section-title">Now playing</h2>
      <div className="jb-panel adm-player">
      <div className="adm-track">
        <div className="adm-art" aria-hidden="true">
          {now?.artworkUrl ? <img src={now.artworkUrl} alt="" /> : <span>♪</span>}
        </div>
        <div className="adm-track-text">
          {now ? (
            <>
              <span className={`adm-kind adm-${now.kind === 'master' ? 'info' : 'warn'}`}>{now.kind === 'master' ? 'Master queue' : 'Request'}</span>
              <p className="adm-now-title" data-testid="now-title">{now.title}</p>
              <p className="adm-dim">{now.artist ?? 'Unknown artist'}{request?.requester ? ` · requested by ${request.requester}` : ''}</p>
              {snapshot.suspendedMaster ? <p className="adm-dim adm-small">“{snapshot.suspendedMaster.title}” resumes at {time(snapshot.suspendedMaster.positionSec)} after this.</p> : null}
            </>
          ) : snapshot.schedule.requestsIdle
            ? <>
                <span className="adm-kind adm-warn">Requests only</span>
                <p className="adm-now-title adm-dim">Waiting for requests.</p>
                {snapshot.suspendedMaster ? <p className="adm-dim adm-small">“{snapshot.suspendedMaster.title}” resumes at {time(snapshot.suspendedMaster.positionSec)} when you switch back.</p> : null}
              </>
            : <p className="adm-now-title adm-dim">Nothing playing. Add songs to the master queue.</p>}
        </div>
      </div>

      <div className="adm-progress">
        <input
          id="adm-seek" type="range" aria-label="Seek" min={0} max={Math.max(1, Math.floor(position.durationSec ?? 1))} step={1}
          value={Math.floor(shownPosition)} disabled={!now || position.durationSec === null}
          onChange={(e) => setDragging(Number(e.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          onBlur={commitSeek}
        />
        <div className="adm-times">
          <span data-testid="position">{time(position.positionSec === null && dragging === null ? null : shownPosition)}</span>
          {caveat ? <span className="adm-warning adm-small">{caveat}</span> : null}
          <span>{time(position.durationSec)}</span>
        </div>
      </div>

      <div className="adm-transport">
        <button type="button" className="adm-btn adm-icon" aria-label="Restart song" title="Restart song" disabled={!now} onClick={() => now && void actions.replay(now.entryId)}>⏮</button>
        <button type="button" className="adm-btn adm-icon" aria-label="Back 15 seconds" title="Back 15 s" disabled={!canSeek} onClick={() => now && void actions.seek(now.entryId, Math.max(0, shownPosition - 15))}>−15</button>
        {playing
          ? <button type="button" className="adm-btn adm-primary adm-play" onClick={() => void actions.pause()}>Pause</button>
          : <button type="button" className="adm-btn adm-primary adm-play" disabled={snapshot.night?.status !== 'open'} onClick={() => void actions.play()}>Play</button>}
        <button type="button" className="adm-btn adm-icon" aria-label="Forward 15 seconds" title="Forward 15 s" disabled={!canSeek} onClick={() => now && void actions.seek(now.entryId, shownPosition + 15)}>+15</button>
        {now ? (
          <ConfirmButton
            label="Skip…" confirmLabel="Skip"
            warning={now.kind === 'request' ? 'Ends this request without giving it back; master music resumes.' : 'Jumps to the next master song. The request timer keeps going.'}
            onConfirm={() => void actions.skip(now.entryId)}
          />
        ) : <button type="button" className="adm-btn" disabled>Skip…</button>}

        <label className="adm-volume" htmlFor="adm-volume">
          <span aria-hidden="true">Vol</span>
          <input id="adm-volume" type="range" aria-label="Volume" min={0} max={100} step={1} value={Math.round(volume * 100)} onChange={(e) => actions.setVolume(Number(e.target.value) / 100)} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); actions.beginVolume(); }} onPointerUp={() => actions.commitVolume()} onPointerCancel={() => actions.commitVolume()} onBlur={() => actions.commitVolume()} />
          <span data-testid="volume">{Math.round(volume * 100)}%</span>

        </label>
      </div>

      <div className={`adm-status adm-${status.tone}`}>
        <span className="adm-dot" aria-hidden="true" />
        <span data-testid="player-state">{PLAYER_LABEL[state]}</span>
        <span data-testid="confirmation" data-confirmation={lapsed ? 'lapsed' : confirmation} hidden />
        <DisplayWait key={snapshot.playback.desiredEpoch} waiting={confirmation === 'requested' || confirmation === 'unconfirmed'} />
        {status.hint ? <span className="adm-status-hint">{status.hint}</span> : null}
      </div>

      {children}
      </div>
    </section>
  );
}

// ------------------------------------------------------------- request turn

export function TurnPanel({ snapshot, serverNow }: { snapshot: Snapshot; serverNow: number }) {
  const turn = describeTurn(snapshot, serverNow);
  return (
    <div className="adm-turn" id="adm-turn" data-kind={turn.kind}>
      <strong data-testid="turn-headline">{turn.headline}</strong>
      <span className="adm-dim" data-testid="turn-detail">{turn.detail}</span>
    </div>
  );
}

// ------------------------------------------------------------ queue control

const MODES: { mode: QueueMode; label: string; help: string }[] = [
  { mode: 'auto', label: 'Auto', help: 'Master music, with one request every interval.' },
  { mode: 'master', label: 'Master only', help: 'Request turns are off. Requests wait in the queue.' },
  { mode: 'requests', label: 'Requests only', help: 'Only requests play, one after another. Silent when none are ready.' },
];

/** Which queue plays and how often requests take a turn. State lives in the service; this only sends commands. */
export function QueueControls({ snapshot, serverNow, actions, intents = [] }: { snapshot: Snapshot; serverNow: number; actions: Actions; intents?: readonly Intent[] }) {
  const { schedule } = snapshot;
  const open = snapshot.night?.status === 'open';
  const pendingMode = optimisticIntent(snapshot, intents, ['queue.mode'])?.payload as { mode: QueueMode } | undefined;
  const mode = pendingMode?.mode ?? schedule.mode;
  const [confirming, setConfirming] = useState(false);
  const current = schedule.phase === 'master' ? snapshot.nowPlaying : null;
  const ready = waitingRequests(snapshot).filter((r) => r.status === 'ready').length;
  const choose = (next: QueueMode) => {
    if (next === 'requests' && current) { setConfirming(true); return; }
    setConfirming(false);
    if (next !== mode) void actions.setMode(next);
  };
  const interruption = current
    ? `Interrupts “${current.title}” now; it resumes where it left off when you leave Requests only.${ready ? '' : ' No request is ready, so music stops until one is.'}`
    : '';

  const minMinutes = Math.ceil(schedule.periodMinMs / 60_000), maxMinutes = Math.floor(schedule.periodMaxMs / 60_000);
  const currentMinutes = Math.round(schedule.periodMs / 60_000);
  const [draft, setDraft] = useState(String(currentMinutes));
  useEffect(() => setDraft(String(currentMinutes)), [currentMinutes]);
  const minutes = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(minutes) && minutes >= minMinutes && minutes <= maxMinutes;
  const elapsedMs = mode === 'auto' && schedule.phase === 'master' && schedule.periodStartedAt !== null ? serverNow - schedule.periodStartedAt : null;
  const alreadyElapsed = valid && elapsedMs !== null && elapsedMs >= minutes * 60_000;
  const overridden = schedule.periodMs !== schedule.periodDefaultMs;

  return (
    <div className="adm-qc" id="adm-queue-control">
      <div className="adm-qc-row">
        <div className="adm-seg" role="radiogroup" aria-label="Play from">
          {MODES.map((m) => (
            <button
              key={m.mode} type="button" role="radio" aria-checked={mode === m.mode} data-mode={m.mode}
              className={`adm-btn adm-seg-btn${mode === m.mode ? ' adm-selected' : ''}`}
              disabled={m.mode === 'requests' && !open} title={m.mode === 'requests' && !open ? 'Start the night first' : m.help}
              onClick={() => choose(m.mode)}
            >{m.label}</button>
          ))}
        </div>
        <form className="adm-interval" onSubmit={(e) => { e.preventDefault(); if (valid) void actions.setInterval(minutes * 60_000); }}>
          <label htmlFor="adm-interval">Request every</label>
          <input id="adm-interval" type="number" inputMode="numeric" min={minMinutes} max={maxMinutes} step={1} value={draft} onChange={(e) => setDraft(e.target.value)} aria-invalid={draft !== '' && !valid} />
          <span aria-hidden="true">min</span>
          <button type="submit" className="adm-btn" disabled={!valid || minutes === currentMinutes}>Set</button>
          {overridden ? <button type="button" className="adm-btn adm-quiet" onClick={() => void actions.setInterval(null)}>Use {formatMinutes(schedule.periodDefaultMs)}</button> : null}
        </form>
      </div>
      <p className="adm-dim adm-small" data-testid="mode-help" aria-live="polite">
        {MODES.find((m) => m.mode === mode)!.help}
        {mode === 'auto' ? ` Now every ${formatMinutes(schedule.periodMs)}.` : ''}
      </p>
      {!valid && draft !== '' ? <p className="adm-warning adm-small" role="alert">Use a whole number from {minMinutes} to {maxMinutes} minutes.</p> : null}
      {alreadyElapsed ? <p className="adm-warning adm-small" data-testid="interval-warning">{formatClock(elapsedMs!)} has already passed in this interval, so saving now makes the turn due right away{ready ? '' : ' (nothing is ready, so the timer just restarts)'}.</p> : null}
      {confirming ? (
        <div className="adm-confirm" role="group" aria-label="Confirm: Requests only">
          <span className="adm-warning">{interruption}</span>
          <button type="button" className="adm-btn adm-danger" onClick={() => { setConfirming(false); void actions.setMode('requests'); }}>Switch to Requests only</button>
          <button type="button" className="adm-btn" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ queues

function MoveButtons({ ids, index, onMove }: { ids: readonly string[]; index: number; onMove: (afterEntryId: string | null) => void }) {
  const move = (direction: Direction) => () => {
    const anchor = moveAnchor(ids, index, direction);
    if (anchor) onMove(anchor.afterEntryId);
  };
  return (
    <>
      <button type="button" className="adm-btn adm-icon adm-quiet" aria-label="Move up" disabled={index === 0} onClick={move('up')}>↑</button>
      <button type="button" className="adm-btn adm-icon adm-quiet" aria-label="Move down" disabled={index === ids.length - 1} onClick={move('down')}>↓</button>
    </>
  );
}

const REQUEST_TAG: Partial<Record<RequestEntryView['status'], [Tone, string]>> = { preparing: ['warn', 'loading'], playing: ['ok', 'playing'], failed: ['bad', 'failed'] };

/** Plays a ready request right now. The interrupted master item resumes at its saved position afterward. */
function PlayNowButton({ snapshot, request, onConfirm }: { snapshot: Snapshot; request: RequestEntryView; onConfirm: () => void }) {
  const open = snapshot.night?.status === 'open';
  const requestPlaying = !!playingRequest(snapshot);
  const current = snapshot.schedule.phase === 'master' ? snapshot.nowPlaying : null;
  const reason = !open ? 'Start the night first' : request.status !== 'ready' ? 'Still loading' : requestPlaying ? 'A request is playing. Move this one to the top to play it next.' : undefined;
  const effects = [
    current ? `Interrupts “${current.title}”; it resumes where it left off afterward.` : 'Starts right away.',
    snapshot.schedule.intent === 'paused' ? 'Playback is paused, so press Play to hear it.' : null,
  ].filter(Boolean).join(' ');
  return <ConfirmButton className="adm-quiet" danger={false} label="Play now…" confirmLabel="Play now" warning={effects} disabled={!!reason} title={reason} onConfirm={onConfirm} />;
}

export function RequestQueuePanel({ snapshot, actions }: { snapshot: Snapshot; actions: Actions }) {
  const playing = playingRequest(snapshot);
  const waiting = waitingRequests(snapshot);
  const ids = waiting.map((r) => r.id);
  const row = (r: RequestEntryView, index: number) => {
    const tag = REQUEST_TAG[r.status];
    return (
      <li key={r.id} className={`adm-row${r.status === 'playing' ? ' adm-current' : ''}`} data-entry={r.id} data-status={r.status}>
        <span className="adm-num">{index < 0 ? '▶' : index + 1}</span>
        <div className="adm-row-main">
          <span className="adm-row-title">{r.title}</span>
          <span className="adm-dim adm-small">{r.artist ?? 'Unknown artist'} · {time(r.durationSec)} · from {r.requester ?? 'unknown'}</span>
          {r.error ? <span className="adm-bad-text adm-small">{r.error}</span> : null}
        </div>
        {tag ? <Tag tone={tag[0]}>{tag[1]}</Tag> : null}
        <div className="adm-row-actions">
          {r.status !== 'playing' ? <MoveButtons ids={ids} index={index} onMove={(after) => void actions.moveRequest(r.id, after, r.title)} /> : null}
          {r.status !== 'playing' ? <PlayNowButton snapshot={snapshot} request={r} onConfirm={() => void actions.playNow(r.id, r.title)} /> : null}
          <ConfirmButton
            className="adm-quiet"
            label="Remove…" confirmLabel="Remove"
            warning={r.status === 'playing' ? 'Stops this request now; master music resumes. They don’t get the request back.' : 'They don’t get the request back.'}
            onConfirm={() => void actions.removeRequest(r.id, r.title)}
          />
        </div>
      </li>
    );
  };
  return (
    <Panel title="Requests queue" id="adm-requests" aside={<span className="adm-dim adm-small">{waiting.length} waiting</span>}>
      {playing || waiting.length ? (
        <ul className="adm-list" aria-label="Request items">
          {playing ? row(playing, -1) : null}
          {waiting.map(row)}
        </ul>
      ) : <p className="adm-empty">{snapshot.night?.status === 'open' ? 'No requests yet.' : 'Requests open when the night starts.'}</p>}
    </Panel>
  );
}

const MASTER_TAG: Partial<Record<MasterEntryView['status'], [Tone, string]>> = { preparing: ['warn', 'loading'], failed: ['bad', 'failed'], unusable: ['bad', 'can’t play'] };

export function MasterQueuePanel({ snapshot, actions }: { snapshot: Snapshot; actions: Actions }) {
  const master = snapshot.master ?? [];
  const ids = master.map((m) => m.id);
  const currentId = snapshot.schedule.phase === 'master' ? snapshot.nowPlaying?.entryId : snapshot.suspendedMaster?.entryId;
  const row = (m: MasterEntryView, index: number) => {
    const isCurrent = m.id === currentId;
    const suspended = snapshot.suspendedMaster?.entryId === m.id;
    const tag = MASTER_TAG[m.status] ?? (m.status === 'ready' ? null : (['dim', m.status] as [Tone, string]));
    return (
      <li key={m.id} className={`adm-row${isCurrent ? ' adm-current' : ''}`} data-entry={m.id} data-status={m.status}>
        <span className="adm-num">{isCurrent ? (suspended ? '❚❚' : '▶') : index + 1}</span>
        <div className="adm-row-main">
          <span className="adm-row-title">{m.title}</span>
          <span className="adm-dim adm-small">{m.artist ?? 'Unknown artist'} · {time(m.durationSec)}{m.isMix ? ' · mix' : ''}</span>
        </div>
        {tag ? <Tag tone={tag[0]}>{tag[1]}</Tag> : null}
        <div className="adm-row-actions">
          <MoveButtons ids={ids} index={index} onMove={(after) => void actions.moveMaster(m.id, after, m.title)} />
          <ConfirmButton
            className="adm-quiet"
            label="Remove…" confirmLabel="Remove"
            warning={suspended ? 'This mix is waiting to resume; the next song plays instead.' : isCurrent ? 'This is playing now; it jumps to the next song.' : undefined}
            onConfirm={() => void actions.removeMaster(m.id, m.title)}
          />
        </div>
      </li>
    );
  };
  return (
    <Panel title="Master queue" id="adm-master" aside={<span className="adm-dim adm-small">{master.length} song{master.length === 1 ? '' : 's'}</span>}>
      {master.length ? <ul className="adm-list" aria-label="Master items">{master.map(row)}</ul> : <p className="adm-empty">Empty. Paste a link above and press Add to master.</p>}
    </Panel>
  );
}

// ------------------------------------------------------------------- add

/** One link box feeding either queue. Organizer requests go through request.submit, so they use the organizer's own nightly allowance. */
export function AddBar({ actions, lastAdd, nightOpen, children }: { actions: Actions; lastAdd: Intent | null; nightOpen: boolean; children?: ReactNode }) {
  const [url, setUrl] = useState('');
  const pending = lastAdd?.status === 'pending';
  const value = url.trim();
  const add = (target: 'master' | 'request') => {
    if (!value || pending) return;
    void (target === 'master' ? actions.addMaster(value) : actions.addRequest(value)).then((intent) => { if (intent.status === 'ok') setUrl(''); });
  };
  return (
    <section className="adm-section" aria-labelledby="adm-queue">
      <h2 id="adm-queue" className="adm-section-title">Queue</h2>
      <form className="jb-panel adm-add" aria-busy={pending} onSubmit={(e) => { e.preventDefault(); add('master'); }}>
      <label htmlFor="adm-add-url" className="adm-sr">YouTube, Spotify, or Apple Music track link</label>
      <div className="adm-add-row">
        <input id="adm-add-url" type="url" inputMode="url" placeholder="YouTube, Spotify, or Apple Music track link" value={url} disabled={pending} onChange={(e) => setUrl(e.target.value)} />
        <button type="submit" className="adm-btn adm-primary" disabled={!value || pending}>Add to master</button>
        <button type="button" className="adm-btn" disabled={!value || !nightOpen || pending} title={nightOpen ? undefined : 'Start the night first'} onClick={() => add('request')}>Add to requests</button>
      </div>
      {pending ? <p className="adm-add-loading adm-small" role="status"><span className="adm-spinner" aria-hidden="true" />Adding to {lastAdd.type === 'master.add' ? 'master' : 'requests'}…</p> : null}
      {lastAdd?.status === 'failed' && lastAdd.error ? <p className="adm-bad-text adm-small" role="alert" data-testid="add-error">{explainError(lastAdd.error, lastAdd.type).message}</p> : null}
      <p className="adm-dim adm-small">YouTube, Spotify, or Apple Music tracks. Master mixes welcome. Requests: under {POLICY.requestMaxSec / 60} min; {POLICY.quotaPerNight} per person per night.</p>
      </form>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- activity

export function ActivityPanel({ intents, actions, hidden = false }: { intents: readonly Intent[]; actions: Actions; hidden?: boolean }) {
  const visible = intents.filter((i) => i.type !== 'playback.volume' || i.status === 'failed');
  return (
    <section id="adm-activity" className="adm-section" aria-labelledby="adm-activity-title" hidden={hidden}>
      <h2 id="adm-activity-title" className="adm-section-title">Action log</h2>
      <div className="adm-activity">
      {!visible.length ? <p className="adm-empty">No actions yet.</p> : null}
      <ul className="adm-list" aria-label="Action log">
        {visible.map((intent) => {
          const explained = intent.error ? explainError(intent.error, intent.type) : null;
          const [tone, label]: [Tone, string] = intent.status === 'ok' ? ['ok', 'sent'] : intent.status === 'pending' ? ['warn', 'sending…'] : explained?.tone === 'conflict' ? ['warn', 'not applied'] : ['bad', 'failed'];
          return (
            <li key={intent.id} className="adm-row" data-status={intent.status} data-intent={intent.type}>
              <time className="adm-action-time adm-dim" dateTime={new Date(intent.startedAt).toISOString()} title={new Date(intent.startedAt).toLocaleString([], { timeZone: 'America/Indiana/Indianapolis' })}>
                {new Date(intent.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/Indiana/Indianapolis' })}
              </time>
              <div className="adm-row-main">
                <span>{intent.label}</span>
                {intent.status === 'failed' && explained ? <span className={`adm-small ${explained.tone === 'transient' ? 'adm-warning' : 'adm-bad-text'}`} role="alert">{explained.message}</span> : null}
                {intent.status === 'ok' && intent.replayed ? <span className="adm-dim adm-small">Already applied earlier.</span> : null}
              </div>
              <Tag tone={tone}>{label}</Tag>
              {intent.status === 'failed' && intent.error?.retryable ? <button type="button" className="adm-btn adm-quiet" onClick={() => actions.retry(intent.id)}>Retry</button> : null}
            </li>
          );
        })}
      </ul>
      </div>
    </section>
  );
}
