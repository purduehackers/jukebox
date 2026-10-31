// Presentational admin components. Props in, callbacks out: no fetching here, so every state
// (offline display, unconfirmed command, conflicts) can be rendered from a fixture snapshot.
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DeviceView, MasterEntryView, RequestEntryView, Snapshot } from '../../../src/contract/types.ts';
import { CONFIRMATION_LABEL, PLAYER_LABEL, describeTurn, estimatePosition, explainError, formatClock, moveAnchor, playerState, playingRequest, waitingRequests } from './derive.ts';
import type { Direction } from './derive.ts';
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
  openNight(): Done;
  closeNight(expectedRevision: number): Done;
  addMaster(url: string): Done;
  removeMaster(entryId: string, title: string): Done;
  moveMaster(entryId: string, afterEntryId: string | null, title: string): Done;
  removeRequest(entryId: string, title: string): Done;
  moveRequest(entryId: string, afterEntryId: string | null, title: string): Done;
  createPairing(name: string): Done;
  revokeDevice(deviceId: string, name: string): Done;
  retry(intentId: string): void;
  dismiss(intentId: string): void;
}

const time = (sec: number | null) => (sec === null ? '–:––' : formatClock(sec * 1000));
const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function Panel({ title, id, children, aside }: { title: string; id: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="jb-panel adm-panel" aria-labelledby={id}>
      <header className="adm-panel-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

const Badge = ({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'info' | 'dim'; children: ReactNode }) => <span className={`adm-badge adm-${tone}`}>{children}</span>;

/** Two-step button: the first press arms it, the second performs the action. */
export function ConfirmButton({ label, confirmLabel, warning, onConfirm, context, danger = true, disabled = false }: {
  label: string; confirmLabel: string; warning?: string; onConfirm: (armedContext: number | undefined) => void; context?: number; danger?: boolean; disabled?: boolean;
}) {
  const [armed, setArmed] = useState<{ context: number | undefined } | null>(null);
  if (!armed) return <button type="button" className="adm-btn" disabled={disabled} onClick={() => setArmed({ context })}>{label}</button>;
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
  if (access.state === 'loading') return <main className="jb-panel adm-gate" aria-busy="true"><p>Checking your session…</p></main>;
  if (access.state === 'signed_out') {
    return (
      <main className="jb-panel adm-gate">
        <h1>{access.expired ? 'Session expired' : 'Organizer sign-in'}</h1>
        <p>{access.expired
          ? 'Your sign-in expired. Nothing you tried since then was applied. Sign in again to keep controlling the jukebox.'
          : 'Sign in with Purdue Hackers ID. Only organizers can control the jukebox.'}</p>
        <a className="adm-btn adm-primary" href="/auth/login?returnTo=/admin">Sign in</a>
      </main>
    );
  }
  return (
    <main className="jb-panel adm-gate">
      <h1>Organizer access required</h1>
      <p>You are signed in as <strong>{access.name}</strong>, which does not have the organizer role. Ask a Purdue Hackers admin for access, or sign in with a different account.</p>
      <button type="button" className="adm-btn" onClick={onRetry}>Check again</button>
      <a className="adm-btn" href="/auth/login?returnTo=/admin">Use a different account</a>
    </main>
  );
}

// --------------------------------------------------------- header + alerts

export function Header({ name, link, linkError, onSignOut }: { name: string; link: Link; linkError: string | null; onSignOut: () => void }) {
  return (
    <header className="adm-header">
      <h1>Jukebox <span className="adm-dim">/ admin</span></h1>
      <div className="adm-header-meta">
        <Badge tone={link === 'live' ? 'ok' : link === 'connecting' ? 'info' : 'bad'}>
          {link === 'live' ? 'Live' : link === 'connecting' ? 'Connecting…' : `Reconnecting${linkError ? ` (${linkError})` : ''}`}
        </Badge>
        <span className="adm-dim">{name}</span>
        <button type="button" className="adm-btn" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}

export function AlertsBand({ snapshot, link, external, onAckExternal }: { snapshot: Snapshot; link: Link; external: boolean; onAckExternal: () => void }) {
  const items: ReactNode[] = [];
  if (link === 'reconnecting') items.push(<li key="link" className="adm-alert adm-bad">Connection to the jukebox service was lost. What you see may be out of date; commands will fail or retry until it returns.</li>);
  for (const alert of snapshot.alerts) {
    items.push(<li key={alert.code} className={`adm-alert ${alert.code === 'unconfirmed_command' || alert.code === 'player_offline' ? 'adm-bad' : 'adm-warn'}`} data-alert={alert.code}>{alert.message}</li>);
  }
  if (external) {
    items.push(
      <li key="ext" className="adm-alert adm-info" data-alert="external_change">
        A queue was changed by someone else (another organizer, or the schedule). The lists below are current.
        <button type="button" className="adm-btn" onClick={onAckExternal}>Dismiss</button>
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
    <Panel title="Night session" id="adm-night" aside={<Badge tone={open ? 'ok' : 'dim'}>{open ? 'Open' : 'Closed'}</Badge>}>
      <p className="adm-dim">
        {open
          ? `Opened ${clockTime(snapshot.night!.openedAt)}. Requests are accepted; each person gets 3 per night.`
          : snapshot.night
            ? `Last night closed ${snapshot.night.closedAt ? clockTime(snapshot.night.closedAt) : ''}. Requests are closed; master music can still play.`
            : 'No night has been opened yet. Requests stay closed until you open one.'}
      </p>
      {open ? (
        <ConfirmButton
          label="Close night…"
          confirmLabel="Close night now"
          context={snapshot.revision}
          warning={`Closing pauses playback, closes submissions, and archives ${waiting} waiting request${waiting === 1 ? '' : 's'}${playing ? ` and stops the request playing now (“${playing.title}”)` : ''}. Quota is not refunded.`}
          onConfirm={(revision) => void actions.closeNight(revision ?? snapshot.revision)}
        />
      ) : (
        <ConfirmButton label="Open night…" confirmLabel="Open night" danger={false} warning="Starts a new quota period: everyone gets 3 requests again." onConfirm={() => void actions.openNight()} />
      )}
    </Panel>
  );
}

// ------------------------------------------------------------- now playing

export function NowPlayingPanel({ snapshot, serverNow, actions, pendingVolume }: { snapshot: Snapshot; serverNow: number; actions: Actions; pendingVolume: number | null }) {
  const now = snapshot.nowPlaying;
  const state = playerState(snapshot);
  const { confirmation } = snapshot.playback;
  const position = estimatePosition(snapshot, serverNow);
  const playing = snapshot.schedule.intent === 'playing';
  const [dragging, setDragging] = useState<number | null>(null);
  const shownPosition = dragging ?? position.positionSec ?? 0;
  const volume = pendingVolume ?? snapshot.playback.volume;
  const tone: Record<string, 'ok' | 'warn' | 'bad' | 'dim'> = { playing: 'ok', paused: 'dim', buffering: 'warn', loading: 'warn', needs_activation: 'warn', offline: 'bad', error: 'bad', no_display: 'bad', ended: 'dim' };
  const confTone = { none: 'dim', requested: 'warn', confirmed: 'ok', unconfirmed: 'bad' } as const;
  // A confirmation from a display that has since gone silent describes the past, not the present.
  const lapsed = confirmation === 'confirmed' && (state === 'offline' || state === 'no_display');
  const confText = lapsed ? 'Last change was confirmed; display now silent' : CONFIRMATION_LABEL[confirmation].label;
  return (
    <Panel title="Now playing" id="adm-now" aside={now ? <Badge tone={now.kind === 'master' ? 'info' : 'warn'}>{now.kind === 'master' ? 'Master' : 'Request'}</Badge> : null}>
      {now ? (
        <>
          <p className="adm-title" data-testid="now-title">{now.title}</p>
          <p className="adm-dim">{now.artist ?? 'Unknown artist'}</p>
          {snapshot.suspendedMaster ? <p className="adm-dim">Master “{snapshot.suspendedMaster.title}” is suspended at {time(snapshot.suspendedMaster.positionSec)} and resumes after this request.</p> : null}
        </>
      ) : <p className="adm-dim">Nothing is loaded. Add a master item and press Play.</p>}

      <div className="adm-status-row">
        <Badge tone={tone[state] ?? 'dim'}><span data-testid="player-state">{PLAYER_LABEL[state]}</span></Badge>
        <Badge tone={lapsed ? 'warn' : confTone[confirmation]}><span data-testid="confirmation">{confText}</span></Badge>
        <Badge tone={playing ? 'ok' : 'dim'}>{playing ? 'Intent: playing' : 'Intent: paused'}</Badge>
      </div>
      {lapsed ? null : confirmation === 'confirmed' ? <p className="adm-dim adm-small">{CONFIRMATION_LABEL[confirmation].detail}</p> : confirmation !== 'none' ? <p className="adm-note">{CONFIRMATION_LABEL[confirmation].detail}</p> : null}
      {state === 'needs_activation' ? <p className="adm-note">Firefox blocked autoplay. Someone at the display must press Activate; nothing can fix this remotely.</p> : null}
      {state === 'error' && snapshot.playback.observed?.error ? <p className="adm-note adm-bad-text">Display error: {snapshot.playback.observed.error}</p> : null}
      {state === 'offline' || state === 'no_display' ? <p className="adm-note">{state === 'offline' ? 'The display stopped reporting. Position below is the last report, not live.' : 'No paired display holds playback. Pair one below and open /display on it.'}</p> : null}

      {now ? (
        <div className="adm-position">
          <label htmlFor="adm-seek">
            Position <span data-testid="position">{time(position.positionSec === null && dragging === null ? null : shownPosition)}</span> / {time(position.durationSec)}
            <span className="adm-dim"> · {position.remainingSec === null ? 'remaining unknown' : `${time(position.remainingSec)} left`}
              {position.basis === 'stale' ? ' (last report, display offline)' : position.basis === 'unconfirmed' ? ' (not confirmed by display)' : position.basis === 'unknown' ? ' (no report yet)' : ''}</span>
          </label>
          <input
            id="adm-seek" type="range" min={0} max={Math.max(1, Math.floor(position.durationSec ?? 1))} step={1}
            value={Math.floor(shownPosition)} disabled={position.durationSec === null}
            onChange={(e) => setDragging(Number(e.target.value))}
            onPointerUp={() => { if (dragging !== null) { void actions.seek(now.entryId, dragging); setDragging(null); } }}
            onKeyUp={() => { if (dragging !== null) { void actions.seek(now.entryId, dragging); setDragging(null); } }}
          />
        </div>
      ) : null}

      <div className="adm-controls">
        {playing
          ? <button type="button" className="adm-btn adm-primary" onClick={() => void actions.pause()}>Pause</button>
          : <button type="button" className="adm-btn adm-primary" onClick={() => void actions.play()}>Play</button>}
        <button type="button" className="adm-btn" disabled={!now} onClick={() => now && void actions.replay(now.entryId)}>Replay</button>
        <button type="button" className="adm-btn" disabled={!now || position.positionSec === null} onClick={() => now && void actions.seek(now.entryId, Math.max(0, (position.positionSec ?? 0) - 15))}>−15 s</button>
        <button type="button" className="adm-btn" disabled={!now || position.positionSec === null} onClick={() => now && void actions.seek(now.entryId, (position.positionSec ?? 0) + 15)}>+15 s</button>
        {now ? (
          <ConfirmButton
            label="Skip…" confirmLabel="Skip now"
            warning={now.kind === 'request' ? 'Skipping a request ends its turn without refunding the requester; master music resumes.' : 'Skips to the next master item. The 15-minute timer is not reset.'}
            onConfirm={() => void actions.skip(now.entryId)}
          />
        ) : null}
      </div>

      <div className="adm-volume">
        <label htmlFor="adm-volume">Volume <span data-testid="volume">{Math.round(volume * 100)}%</span>
          <span className="adm-dim"> · {pendingVolume !== null ? 'sending…' : confirmation === 'confirmed' ? (lapsed ? 'last confirmed before the display went silent' : 'confirmed by display') : confirmation === 'none' ? 'saved' : confirmation === 'requested' ? 'requested, awaiting display' : 'unconfirmed by display'}</span>
        </label>
        <input id="adm-volume" type="range" min={0} max={100} step={1} value={Math.round(volume * 100)} onChange={(e) => actions.setVolume(Number(e.target.value) / 100)} />
        <p className="adm-dim adm-small">This is the player volume in the browser, not the laptop’s HDMI/system volume.</p>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------- request turn

export function TurnPanel({ snapshot, serverNow }: { snapshot: Snapshot; serverNow: number }) {
  const turn = describeTurn(snapshot, serverNow);
  const tone = { night_closed: 'dim', in_request: 'warn', not_started: 'dim', counting: 'info', due: 'warn', elapsed_empty: 'dim' } as const;
  return (
    <Panel title="Next request turn" id="adm-turn" aside={<Badge tone={tone[turn.kind]}>{turn.kind.replace('_', ' ')}</Badge>}>
      <p className="adm-title" data-testid="turn-headline">{turn.headline}</p>
      <p data-testid="turn-detail">{turn.detail}</p>
      <p className="adm-dim adm-small">
        {turn.readyRequests} ready · {turn.preparingRequests} preparing. Elapsed time counts through pause, buffering and offline; seeking never moves it.
      </p>
    </Panel>
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
      <button type="button" className="adm-btn adm-icon" aria-label="Move up" disabled={index === 0} onClick={move('up')}>↑</button>
      <button type="button" className="adm-btn adm-icon" aria-label="Move down" disabled={index === ids.length - 1} onClick={move('down')}>↓</button>
    </>
  );
}

export function RequestQueuePanel({ snapshot, actions }: { snapshot: Snapshot; actions: Actions }) {
  const playing = playingRequest(snapshot);
  const waiting = waitingRequests(snapshot);
  const ids = waiting.map((r) => r.id);
  const row = (r: RequestEntryView, index: number) => (
    <li key={r.id} className="adm-row" data-entry={r.id}>
      <div className="adm-row-main">
        <span className="adm-title">{r.title}</span>
        <span className="adm-dim">{r.artist ?? 'Unknown artist'} · {time(r.durationSec)} · from {r.requester ?? 'unknown'}</span>
        {r.error ? <span className="adm-bad-text">{r.error}</span> : null}
      </div>
      <Badge tone={r.status === 'ready' ? 'ok' : r.status === 'playing' ? 'warn' : 'dim'}>{r.status}</Badge>
      <div className="adm-row-actions">
        {r.status !== 'playing' ? <MoveButtons ids={ids} index={index} onMove={(after) => void actions.moveRequest(r.id, after, r.title)} /> : null}
        <ConfirmButton
          label="Remove…" confirmLabel={r.status === 'playing' ? 'Remove and end turn' : 'Remove, no refund'}
          warning={r.status === 'playing'
            ? 'This request is playing now. Removing it ends its turn without a refund; master music resumes at its saved position and a fresh 15-minute period starts.'
            : 'The requester’s allowance is not refunded.'}
          onConfirm={() => void actions.removeRequest(r.id, r.title)}
        />
      </div>
    </li>
  );
  return (
    <Panel title="Request queue" id="adm-requests" aside={<Badge tone="dim">{waiting.length} waiting</Badge>}>
      {playing ? <ul className="adm-list" aria-label="Playing request">{row(playing, -1)}</ul> : null}
      {waiting.length ? <ul className="adm-list" aria-label="Waiting requests">{waiting.map(row)}</ul> : <p className="adm-dim">{snapshot.night?.status === 'open' ? 'No requests waiting.' : 'Requests are closed (no open night).'}</p>}
    </Panel>
  );
}

export function MasterQueuePanel({ snapshot, actions, lastAdd }: { snapshot: Snapshot; actions: Actions; lastAdd: Intent | null }) {
  const master = snapshot.master ?? [];
  const ids = master.map((m) => m.id);
  const currentId = snapshot.schedule.phase === 'master' ? snapshot.nowPlaying?.entryId : snapshot.suspendedMaster?.entryId;
  const [url, setUrl] = useState('');
  const row = (m: MasterEntryView, index: number) => {
    const isCurrent = m.id === currentId;
    const suspended = snapshot.suspendedMaster?.entryId === m.id;
    return (
      <li key={m.id} className="adm-row" data-entry={m.id}>
        <div className="adm-row-main">
          <span className="adm-title">{m.title}</span>
          <span className="adm-dim">{m.artist ?? 'Unknown artist'} · {time(m.durationSec)}{m.isMix ? ' · mix (interruptible)' : ''}</span>
        </div>
        <div className="adm-tags">
          {isCurrent ? <Badge tone="info">{suspended ? 'suspended' : 'current'}</Badge> : null}
          <Badge tone={m.status === 'ready' ? 'ok' : m.status === 'preparing' ? 'warn' : 'bad'}>{m.status}</Badge>
        </div>
        <div className="adm-row-actions">
          <MoveButtons ids={ids} index={index} onMove={(after) => void actions.moveMaster(m.id, after, m.title)} />
          <ConfirmButton
            label="Remove…" confirmLabel="Remove"
            warning={suspended ? 'This mix is suspended while a request plays; removing it means the next master item plays after the request.'
              : isCurrent ? 'This is the current master item; removing it jumps to the next one.' : undefined}
            onConfirm={() => void actions.removeMaster(m.id, m.title)}
          />
        </div>
      </li>
    );
  };
  return (
    <Panel title="Master queue" id="adm-master" aside={<Badge tone="dim">{master.length} items</Badge>}>
      <form className="adm-add" onSubmit={(e) => {
        e.preventDefault();
        const value = url.trim();
        if (!value) return;
        void actions.addMaster(value).then((intent) => { if (intent.status === 'ok') setUrl(''); });
      }}>
        <label htmlFor="adm-add-url">Add a YouTube track or mix link</label>
        <div className="adm-add-row">
          <input id="adm-add-url" type="url" inputMode="url" placeholder="https://youtu.be/…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="submit" className="adm-btn adm-primary" disabled={!url.trim()}>Add</button>
        </div>
        {lastAdd?.status === 'failed' && lastAdd.error ? <p className="adm-note adm-bad-text" role="alert" data-testid="add-error">{explainError(lastAdd.error, 'master.add').message}</p> : null}
        <p className="adm-dim adm-small">
          Supported: single YouTube tracks and mixes (audio only; video is never fetched). Not yet supported: Spotify and Apple Music links (no audio matching exists)
          and playlist/album import (needs a contract change; see docs/jukebox/proposals/phase-4a.md).
        </p>
      </form>
      {master.length ? <ul className="adm-list" aria-label="Master items">{master.map(row)}</ul> : <p className="adm-dim">The master queue is empty. Add music, then press Play.</p>}
    </Panel>
  );
}

// ----------------------------------------------------------------- devices

export function DevicesPanel({ devices, pairing, actions }: {
  devices: DeviceView[];
  pairing: { name: string; code: string; expiresAt: number } | null;
  actions: Actions;
}) {
  const [name, setName] = useState('Wall Firefox');
  return (
    <Panel title="Display devices" id="adm-devices">
      <form className="adm-add" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void actions.createPairing(name.trim()); }}>
        <label htmlFor="adm-device-name">Device name</label>
        <div className="adm-add-row">
          <input id="adm-device-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="adm-btn" disabled={!name.trim()}>New pairing code</button>
        </div>
      </form>
      {pairing ? (
        <p className="adm-pairing" role="status">
          Enter this code on <strong>{pairing.name}</strong> within 10 minutes (until {clockTime(pairing.expiresAt)}):{' '}
          <code data-testid="pairing-code">{pairing.code}</code>. It is shown once and works once.
        </p>
      ) : null}
      {devices.length ? (
        <ul className="adm-list" aria-label="Paired devices">
          {devices.map((d) => (
            <li key={d.id} className="adm-row">
              <div className="adm-row-main"><span className="adm-title">{d.name}</span><span className="adm-dim">paired {clockTime(d.pairedAt)}</span></div>
              <Badge tone={d.revoked ? 'bad' : d.holdsLease ? 'ok' : 'dim'}>{d.revoked ? 'revoked' : d.holdsLease ? 'plays audio' : 'idle'}</Badge>
              {!d.revoked ? <ConfirmButton label="Revoke…" confirmLabel="Revoke device" warning={d.holdsLease ? 'This display is playing now; revoking silences the venue until another is paired.' : undefined} onConfirm={() => void actions.revokeDevice(d.id, d.name)} /> : null}
            </li>
          ))}
        </ul>
      ) : <p className="adm-dim">No paired displays.</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------- activity

export function ActivityPanel({ intents, actions }: { intents: readonly Intent[]; actions: Actions }) {
  if (!intents.length) return null;
  return (
    <Panel title="Recent actions" id="adm-activity">
      <ul className="adm-list" aria-label="Recent actions">
        {intents.map((intent) => {
          const explained = intent.error ? explainError(intent.error, intent.type) : null;
          return (
            <li key={intent.id} className="adm-row" data-status={intent.status} data-intent={intent.type}>
              <div className="adm-row-main">
                <span>{intent.label}</span>
                {intent.status === 'failed' && explained ? <span className={explained.tone === 'transient' ? 'adm-warning' : 'adm-bad-text'} role="alert">{explained.message}</span> : null}
                {intent.status === 'ok' && intent.replayed ? <span className="adm-dim adm-small">Already applied earlier (duplicate delivery ignored).</span> : null}
              </div>
              <Badge tone={intent.status === 'ok' ? 'ok' : intent.status === 'pending' ? 'warn' : explained?.tone === 'conflict' ? 'warn' : 'bad'}>
                {intent.status === 'ok' ? 'accepted' : intent.status === 'pending' ? 'sending…' : explained?.tone === 'conflict' ? 'not applied' : 'failed'}
              </Badge>
              {intent.status === 'failed' && intent.error?.retryable ? <button type="button" className="adm-btn" onClick={() => actions.retry(intent.id)}>Retry</button> : null}
              {intent.status !== 'pending' ? <button type="button" className="adm-btn adm-icon" aria-label="Dismiss" onClick={() => actions.dismiss(intent.id)}>×</button> : null}
            </li>
          );
        })}
      </ul>
      <p className="adm-dim adm-small">“Accepted” means the server took the command; the Now playing panel shows whether the display confirmed it.</p>
    </Panel>
  );
}
