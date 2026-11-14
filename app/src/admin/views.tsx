// Presentational admin views as React components. Props in, elements out: no fetching or browser
// globals required, so unit/SSR tests render live snapshots directly with renderToStaticMarkup.
import type { ReactNode } from 'react';
import type {
  MasterEntryView,
  QueueActivityEntry,
  QueueMode,
  RequestEntryView,
  Snapshot,
} from '../../../src/contract/types.ts';
import { Badge } from '../components/ph/badge.tsx';
import { Button } from '../components/ph/button.tsx';
import { Card } from '../components/ph/card.tsx';
import { DitherButton } from '../components/ph/dither-button.tsx';
import { Field } from '../components/ph/field.tsx';
import { Icon } from '../components/ph/icon.tsx';
import { Input } from '../components/ph/input.tsx';
import type { BadgeColor } from '../components/ph/badge.tsx';
import {
  PLAYER_LABEL,
  describeTurn,
  estimatePosition,
  explainError,
  formatClock,
  optimisticIntent,
  playerState,
  playingRequest,
  waitingRequests,
} from './derive.ts';
import type { PlayerState } from './derive.ts';
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
  setTimerPaused?(paused: boolean): Done;
  setInterval(periodMs: number | null): Done;
  setQuota(enabled: boolean): Done;
  playNow(entryId: string, title: string): Done;
  removeRequest(entryId: string, title: string): Done;
  moveRequest(entryId: string, afterEntryId: string | null, title: string): Done;
  banUsername(username: string): Done;
  unbanUsername(username: string): Done;
  retry(intentId: string): void;
}

const time = (sec: number | null) => (sec === null ? '–:––' : formatClock(sec * 1000));

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'dim';
const TONE_BADGE: Record<Tone, BadgeColor> = {
  ok: 'lime',
  warn: 'yellow',
  bad: 'orange',
  info: 'pink',
  dim: 'outline',
};

function Tip({ title, children }: { title?: string; children: ReactNode }) {
  return title ? (
    <span className="adm-tip" title={title}>
      {children}
    </span>
  ) : (
    <>{children}</>
  );
}

function Panel({ title, id, children, aside }: { title: string; id: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="adm-panel" aria-labelledby={id}>
      <Card className="adm-card">
        <header className="adm-panel-head">
          <h2 id={id} className="adm-headline adm-panel-title">
            {title}
          </h2>
          {aside}
        </header>
        {children}
      </Card>
    </section>
  );
}

const tag = (tone: Tone, label: string) => <Badge color={TONE_BADGE[tone]}>{label}</Badge>;

export function ConfirmButton(props: {
  label: string;
  confirmLabel: string;
  warning?: string;
  onConfirm?: (armedContext: number | undefined) => void;
  context?: number;
  danger?: boolean;
  disabled?: boolean;
  quiet?: boolean;
  title?: string;
  armed?: boolean;
  confirmId?: string;
}) {
  const {
    label,
    confirmLabel,
    warning,
    context,
    danger = true,
    disabled = false,
    quiet = false,
    title,
    armed = false,
    confirmId,
  } = props;
  if (!armed) {
    return (
      <Tip title={title}>
        <Button variant={quiet ? 'ghost' : 'outline'} disabled={disabled} data-confirm-arm={confirmId} data-confirm-context={context}>
          {label}
        </Button>
      </Tip>
    );
  }
  return (
    <span className="adm-confirm" role="group" aria-label={`Confirm: ${label}`}>
      {warning && <span className="adm-warning">{warning}</span>}
      <Button variant="solid" className={danger ? 'adm-danger' : undefined} data-confirm-exec={confirmId} data-confirm-context={context}>
        {confirmLabel}
      </Button>
      <Button variant="outline" data-confirm-cancel={confirmId}>
        Cancel
      </Button>
    </span>
  );
}

// ------------------------------------------------------------------ access

function GateShell({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <main className="ph-ui dark adm-root" aria-busy={busy || undefined}>
      <div className="adm-shell">
        <Card className="adm-card adm-gate">{children}</Card>
      </div>
    </main>
  );
}

export function AccessGate({ access }: { access: Exclude<Access, { state: 'admin' }>; onRetry?: () => void }) {
  if (access.state === 'loading') return <GateShell busy><p>Checking your sign-in…</p></GateShell>;
  if (access.state === 'signed_out') {
    const title = access.expired ? 'Session expired' : 'Organizer sign-in';
    const copy = access.expired
      ? 'Your sign-in expired. Nothing you tried since then was applied. Sign in again to keep going.'
      : 'Sign in with Purdue Hackers ID. Only organizers can control the jukebox.';
    return (
      <GateShell busy={false}>
        <h1 className="adm-headline adm-h1">{title}</h1>
        <p>{copy}</p>
        <DitherButton href="/auth/login?returnTo=/admin">Sign in</DitherButton>
      </GateShell>
    );
  }
  return (
    <GateShell busy={false}>
      <h1 className="adm-headline adm-h1">Organizer access required</h1>
      <p>
        You are signed in as <strong>{access.name}</strong>, but this sign-in doesn’t include organizer access. If your PH ID
        access changed recently, check again to refresh it.
      </p>
      <div className="adm-gate-actions">
        <DitherButton href="/auth/login?returnTo=/admin">Check again</DitherButton>
        <Button variant="outline" size="lg" href="/auth/login?returnTo=/admin">
          Use a different account
        </Button>
      </div>
    </GateShell>
  );
}

// --------------------------------------------------------- header + alerts

export function HeaderMeta({
  name,
  link,
  linkError,
}: {
  name: string;
  link: Link;
  linkError: string | null;
}) {
  const tone = link === 'live' ? 'ok' : link === 'connecting' ? 'info' : 'bad';
  const label = link === 'live' ? 'Live' : link === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <>
      <span className={`adm-link adm-${tone}`} title={linkError ?? undefined}>
        <span className="adm-dot" aria-hidden="true" />
        {label}
      </span>
      <span className="adm-dim">{name}</span>
      <Button variant="ghost" data-adm-sign-out="true">
        Sign out
      </Button>
    </>
  );
}

const alertIcon = () => <Icon name="exclamation-triangle" className="adm-alert-icon" />;

export function AlertsBand({
  snapshot,
  link,
  external,
}: {
  snapshot: Snapshot;
  link: Link;
  external: boolean;
  onAckExternal?: () => void;
}) {
  const items: ReactNode[] = [];
  if (link === 'reconnecting') {
    items.push(
      <li key="link" className="adm-alert adm-bad">
        <span className="adm-alert-text">
          {alertIcon()}
          Connection to the jukebox service was lost. What you see may be out of date until it reconnects.
        </span>
      </li>,
    );
  }
  for (const alert of snapshot.alerts) {
    if (alert.code === 'unconfirmed_command') continue; // Delayed inline indicator owns acknowledgement feedback.
    items.push(
      <li key={alert.code} className={`adm-alert ${alert.code === 'player_offline' ? 'adm-bad' : 'adm-warn'}`} data-alert={alert.code}>
        <span className="adm-alert-text">
          {alertIcon()}
          {alert.message}
        </span>
      </li>,
    );
  }
  if (external) {
    items.push(
      <li key="external" className="adm-alert adm-info" data-alert="external_change">
        <span className="adm-alert-text">Someone else changed a queue. The lists are up to date.</span>
        <Button variant="outline" data-adm-ack-external="true">
          OK
        </Button>
      </li>,
    );
  }
  if (!items.length) return null;
  return (
    <ul className="adm-alerts" role="status" aria-live="polite">
      {items}
    </ul>
  );
}

// ------------------------------------------------------------------- night

export function NightPanel({
  snapshot,
  armed = false,
}: {
  snapshot: Snapshot;
  actions?: Actions;
  armed?: boolean;
}) {
  const open = snapshot.night?.status === 'open';
  const waiting = waitingRequests(snapshot).length;
  const playing = playingRequest(snapshot);
  return (
    <div className="adm-night" id="adm-night" data-open={open}>
      {open ? (
        <ConfirmButton
          label="End night…"
          confirmLabel="End night"
          context={snapshot.revision}
          armed={armed}
          confirmId="night-close"
          warning={`Stops the music, closes requests, and clears ${waiting} waiting request${waiting === 1 ? '' : 's'}${playing ? ` and “${playing.title}”` : ''}. Nobody gets requests back.`}
        />
      ) : (
        <DitherButton data-adm-night-open="true">Start night</DitherButton>
      )}
    </div>
  );
}

export function BanListItems({ bannedUsernames = [] }: { bannedUsernames?: readonly string[] }) {
  if (!bannedUsernames.length) {
    return <li className="adm-dim adm-small">No banned usernames.</li>;
  }
  return (
    <>
      {bannedUsernames.map((name) => (
        <li key={name}>
          <span>{name}</span>
          <Button variant="ghost" size="sm" data-adm-unban={name}>
            Unban
          </Button>
        </li>
      ))}
    </>
  );
}

export function BanMenu({
  snapshot,
  open = false,
  username = '',
  onUsernameChange,
}: {
  snapshot: Snapshot;
  actions?: Actions;
  open?: boolean;
  username?: string;
  onUsernameChange?: (value: string) => void;
}) {
  const valid = /^[a-zA-Z0-9._-]{1,40}$/.test(username.trim());
  return (
    <div className="adm-ban-menu">
      <Button
        variant="outline"
        aria-expanded={open}
        aria-controls="adm-ban-submenu"
        aria-haspopup="dialog"
        data-adm-ban-toggle="true"
      >
        Ban…
      </Button>
      {open && (
        <div id="adm-ban-submenu">
          <Card className="adm-ban-submenu">
            <h2 className="ph-subheadline">Request bans</h2>
            <p className="adm-small">Blocks new submissions by this PH ID username. Existing requests stay in the queue.</p>
            <form className="adm-ban-form" data-adm-ban-form>
              <Field label="PH ID username" htmlFor="adm-ban-username" hint="Letters, numbers, dot, underscore or hyphen.">
                <Input
                  id="adm-ban-username"
                  autoComplete="off"
                  maxLength={40}
                  value={username}
                  onChange={(event) => onUsernameChange?.(event.target.value)}
                />
              </Field>
              <Button type="submit" disabled={!valid} data-adm-ban-submit="true">
                Ban username
              </Button>
            </form>
            <ul className="adm-ban-list" aria-label="Banned usernames">
              <BanListItems bannedUsernames={snapshot.bannedUsernames ?? []} />
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- now playing

const STATE_TONE: Record<PlayerState, Tone> = {
  playing: 'ok',
  paused: 'dim',
  buffering: 'warn',
  loading: 'warn',
  needs_activation: 'warn',
  offline: 'bad',
  error: 'bad',
  no_display: 'bad',
  ended: 'dim',
};

function displayStatus(snapshot: Snapshot, state: PlayerState): { tone: Tone; hint: string | null } {
  if (state === 'no_display') return { tone: 'warn', hint: null };
  if (state === 'needs_activation') {
    return { tone: 'warn', hint: 'Allow autoplay for this site in Firefox’s address bar.' };
  }
  if (state === 'error') return { tone: 'bad', hint: snapshot.playback.observed?.error ?? null };
  return { tone: STATE_TONE[state], hint: null };
}

export function DisplayWait({ waiting, delayed = false }: { waiting: boolean; delayed?: boolean }) {
  return (
    <span
      className="adm-display-wait"
      role="status"
      hidden={!waiting || !delayed}
      title="Still waiting for the display. Check its connection."
    >
      <span className="adm-spinner" aria-hidden="true" />
      <span className="adm-sr">Still waiting for the display. Check its connection.</span>
    </span>
  );
}

export function NowPlayingPanel({
  snapshot,
  serverNow,
  pendingVolume,
  intents = [],
  children,
  dragging = null,
  displayDelayed = false,
  armedSkip = false,
  onSeekChange,
  onSeekCommit,
  onVolumeBegin,
  onVolumeChange,
  onVolumeCommit,
}: {
  intents?: readonly Intent[];
  snapshot: Snapshot;
  serverNow: number;
  actions?: Actions;
  pendingVolume: number | null;
  children?: ReactNode;
  dragging?: number | null;
  displayDelayed?: boolean;
  armedSkip?: boolean;
  onSeekChange?: (value: number) => void;
  onSeekCommit?: () => void;
  onVolumeBegin?: () => void;
  onVolumeChange?: (volume: number) => void;
  onVolumeCommit?: () => void;
}) {
  const now = snapshot.nowPlaying;
  const state = playerState(snapshot);
  const { confirmation } = snapshot.playback;
  const position = estimatePosition(snapshot, serverNow);
  const transportIntent = optimisticIntent(snapshot, intents, ['playback.play', 'playback.pause']);
  const seekIntent = optimisticIntent(snapshot, intents, ['playback.seek']);
  const volumeIntent = optimisticIntent(snapshot, intents, ['playback.volume']);
  const playing = transportIntent
    ? transportIntent.type === 'playback.play'
    : snapshot.schedule.intent === 'playing';
  const seek = seekIntent?.payload as { entryId: string; positionSec: number } | undefined;
  const localPosition = seek?.entryId === now?.entryId ? seek?.positionSec : undefined;
  const shownPosition = dragging ?? localPosition ?? position.positionSec ?? 0;
  const volume =
    pendingVolume ??
    (volumeIntent?.payload as { volume: number } | undefined)?.volume ??
    snapshot.playback.volume;
  const lapsed = confirmation === 'confirmed' && (state === 'offline' || state === 'no_display');
  const status = displayStatus(snapshot, state);
  const request = now?.kind === 'request' ? snapshot.requests.find((r) => r.id === now.entryId) : undefined;
  const canSeek = !!now && position.positionSec !== null;

  let trackText: ReactNode;
  if (now) {
    const metaText = `${now.artist ?? 'Unknown artist'}${request?.requester ? ` · requested by ${request.requester}` : ''}`;
    trackText = (
      <>
        <p className="adm-headline adm-now-title" data-testid="now-title">
          {now.title}
        </p>
        <p className="adm-meta">
          <Badge className="adm-kind" color={now.kind === 'master' ? 'purple' : 'yellow'}>
            {now.kind === 'master' ? 'Master queue' : 'Request'}
          </Badge>
          <span className="adm-dim">{metaText}</span>
        </p>
        {snapshot.suspendedMaster && (
          <p className="adm-dim adm-small">
            “{snapshot.suspendedMaster.title}” resumes at {time(snapshot.suspendedMaster.positionSec)} after this.
          </p>
        )}
      </>
    );
  } else if (snapshot.schedule.requestsIdle) {
    trackText = (
      <>
        <p className="adm-headline adm-now-title adm-dim">Waiting for requests.</p>
        <p className="adm-meta">
          <Badge className="adm-kind" color="yellow">
            Requests only
          </Badge>
        </p>
        {snapshot.suspendedMaster && (
          <p className="adm-dim adm-small">
            “{snapshot.suspendedMaster.title}” resumes at {time(snapshot.suspendedMaster.positionSec)} when you switch back.
          </p>
        )}
      </>
    );
  } else {
    trackText = <p className="adm-headline adm-now-title adm-dim">Nothing playing. Add songs to the master queue.</p>;
  }

  const seekMax = Math.max(1, Math.floor(position.durationSec ?? 1));
  const seekVal = Math.floor(shownPosition);
  const seekDisabled = !now || position.durationSec === null;
  const posLabel = time(position.positionSec === null && dragging === null ? null : shownPosition);

  const volPct = Math.round(volume * 100);

  return (
    <section className="adm-section" aria-labelledby="adm-now">
      <h2 id="adm-now" className="adm-headline adm-section-title">
        Now playing
      </h2>
      <Card className="adm-card adm-player">
        <div className="adm-track">
          <div className={`adm-art${now?.artworkUrl ? '' : ' dither-field'}`} aria-hidden="true">
            {now?.artworkUrl && <img src={now.artworkUrl} alt="" />}
          </div>
          <div className="adm-track-text">{trackText}</div>
        </div>
        <div className="adm-progress">
          <input
            id="adm-seek"
            type="range"
            aria-label="Seek"
            min={0}
            max={seekMax}
            step={1}
            value={seekVal}
            disabled={seekDisabled}
            onChange={(event) => onSeekChange?.(Number(event.target.value))}
            onPointerUp={() => onSeekCommit?.()}
            onKeyUp={() => onSeekCommit?.()}
            onBlur={() => onSeekCommit?.()}
          />
          <div className="adm-times">
            <span data-testid="position">{posLabel}</span>
            <span data-adm-duration>{time(position.durationSec)}</span>
          </div>
        </div>
        <div className="adm-transport">
          <Button
            variant="outline"
            className="adm-icon"
            icon="refresh"
            disabled={!now}
            aria-label="Restart song"
            title="Restart song"
            data-adm-replay={now?.entryId}
          />
          <Button
            variant="outline"
            className="adm-icon"
            disabled={!canSeek}
            aria-label="Back 15 seconds"
            title="Back 15 s"
            data-adm-seek-rel="-15"
            data-adm-entry={now?.entryId}
          >
            −15
          </Button>
          {playing ? (
            <DitherButton className="adm-play" data-adm-pause="true">
              Pause
            </DitherButton>
          ) : (
            <DitherButton className="adm-play" disabled={snapshot.night?.status !== 'open'} data-adm-play="true">
              Play
            </DitherButton>
          )}
          <Button
            variant="outline"
            className="adm-icon"
            disabled={!canSeek}
            aria-label="Forward 15 seconds"
            title="Forward 15 s"
            data-adm-seek-rel="15"
            data-adm-entry={now?.entryId}
          >
            +15
          </Button>
          {now ? (
            <ConfirmButton
              label="Skip…"
              confirmLabel="Skip"
              armed={armedSkip}
              confirmId="skip-now"
              warning={
                now.kind === 'request'
                  ? 'Ends this request without giving it back; master music resumes.'
                  : 'Jumps to the next master song. The request timer keeps going.'
              }
            />
          ) : (
            <Button variant="outline" disabled>
              Skip…
            </Button>
          )}
          <label className="adm-volume" htmlFor="adm-volume">
            <span aria-hidden="true">Vol</span>
            <input
              id="adm-volume"
              type="range"
              aria-label="Volume"
              min={0}
              max={100}
              step={1}
              value={volPct}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                onVolumeBegin?.();
              }}
              onChange={(event) => onVolumeChange?.(Number(event.target.value) / 100)}
              onPointerUp={() => onVolumeCommit?.()}
              onPointerCancel={() => onVolumeCommit?.()}
              onBlur={() => onVolumeCommit?.()}
            />
            <span data-testid="volume">{volPct}%</span>
          </label>
        </div>
        <div className={`adm-status adm-${status.tone}`}>
          <span className="adm-dot" aria-hidden="true" />
          <span data-testid="player-state">{PLAYER_LABEL[state]}</span>
          <span data-testid="confirmation" data-confirmation={lapsed ? 'lapsed' : confirmation} hidden />
          <DisplayWait waiting={confirmation === 'requested' || confirmation === 'unconfirmed'} delayed={displayDelayed} />
          {status.hint && <span className="adm-status-hint">{status.hint}</span>}
        </div>
        {children}
      </Card>
    </section>
  );
}

// ------------------------------------------------------------- request turn

export function TurnPanel({ snapshot, serverNow }: { snapshot: Snapshot; serverNow: number }) {
  const turn = describeTurn(snapshot, serverNow);
  if (turn.kind === 'in_request') return null;
  return (
    <div className="adm-turn" id="adm-turn" data-kind={turn.kind}>
      <strong data-testid="turn-headline">{turn.headline}</strong>
    </div>
  );
}

// ------------------------------------------------------------ queue control

const MODES: { mode: QueueMode; label: string; help: string }[] = [
  { mode: 'auto', label: 'Auto', help: 'Master music, with one request every interval.' },
  { mode: 'master', label: 'Master only', help: 'Request turns are off. Requests wait in the queue.' },
  { mode: 'requests', label: 'Requests only', help: 'Only requests play, one after another. Silent when none are ready.' },
];

export function QueueControls({
  snapshot,
  serverNow,
  intents = [],
  draft: providedDraft,
  confirming = false,
  onDraftChange,
}: {
  snapshot: Snapshot;
  serverNow: number;
  actions?: Actions;
  intents?: readonly Intent[];
  draft?: string;
  confirming?: boolean;
  onDraftChange?: (value: string) => void;
}) {
  const { schedule } = snapshot;
  const open = snapshot.night?.status === 'open';
  const pendingMode = optimisticIntent(snapshot, intents, ['queue.mode'])?.payload as
    | { mode: QueueMode }
    | undefined;
  const mode = pendingMode?.mode ?? schedule.mode;
  const current = schedule.phase === 'master' ? snapshot.nowPlaying : null;
  const ready = waitingRequests(snapshot).filter((r) => r.status === 'ready').length;
  const interruption = current
    ? `Interrupts “${current.title}” now; it resumes where it left off when you leave Requests only.${ready ? '' : ' No request is ready, so music stops until one is.'}`
    : '';

  const minMinutes = Math.ceil(schedule.periodMinMs / 60_000);
  const maxMinutes = Math.floor(schedule.periodMaxMs / 60_000);
  const currentMinutes = Math.round(schedule.periodMs / 60_000);
  const draft = providedDraft ?? String(currentMinutes);
  const minutes = Number(draft);
  const valid =
    draft.trim() !== '' && Number.isInteger(minutes) && minutes >= minMinutes && minutes <= maxMinutes;
  const elapsedMs =
    mode === 'auto' && schedule.phase === 'master' && schedule.periodStartedAt !== null
      ? (schedule.periodPausedAt ?? serverNow) - schedule.periodStartedAt
      : null;
  const alreadyElapsed =
    schedule.periodPausedAt == null && valid && elapsedMs !== null && elapsedMs >= minutes * 60_000;

  return (
    <div className="adm-qc" id="adm-queue-control">
      <div className="adm-qc-row">
        <div className="adm-seg" role="radiogroup" aria-label="Play from">
          {MODES.map((m) => {
            const unavailable = m.mode === 'requests' && !open;
            return (
              <Tip key={m.mode} title={unavailable ? 'Start the night first' : m.help}>
                <Button
                  variant="outline"
                  disabled={unavailable}
                  className={`adm-seg-btn${mode === m.mode ? ' adm-selected' : ''}`}
                  role="radio"
                  aria-checked={mode === m.mode}
                  data-mode={m.mode}
                >
                  {m.label}
                </Button>
              </Tip>
            );
          })}
        </div>
        {mode === 'auto' && schedule.phase === 'master' && schedule.periodStartedAt !== null && (
          <Button variant="outline" data-adm-timer-pause="true">
            {schedule.periodPausedAt == null ? 'Pause request timer' : 'Resume request timer'}
          </Button>
        )}
        <Tip title={snapshot.quotaEnabled ? 'Each person gets 3 requests per night. Turn off for unlimited requests.' : 'Request quota is off: everyone can request without a limit.'}>
          <Button variant="outline" data-adm-quota-toggle="true" aria-pressed={snapshot.quotaEnabled}>
            {snapshot.quotaEnabled ? 'Disable request quota' : 'Enable request quota'}
          </Button>
        </Tip>
        <form className="adm-interval" data-adm-interval-form>
          <Field label="Request every" htmlFor="adm-interval">
            <div className="adm-interval-row">
              <Input
                id="adm-interval"
                type="number"
                inputMode="numeric"
                min={minMinutes}
                max={maxMinutes}
                step={1}
                value={draft}
                aria-invalid={draft !== '' && !valid ? true : undefined}
                onChange={(event) => onDraftChange?.(event.target.value)}
              />
              <span aria-hidden="true">min</span>
              <Button type="submit" variant="outline" disabled={!valid || minutes === currentMinutes} data-adm-interval-set="true">
                Set
              </Button>
            </div>
          </Field>
        </form>
      </div>
      {!valid && draft !== '' && (
        <p className="adm-warning adm-small" role="alert">
          Use a whole number from {minMinutes} to {maxMinutes} minutes.
        </p>
      )}
      {alreadyElapsed && (
        <p className="adm-warning adm-small" data-testid="interval-warning">
          {formatClock(elapsedMs!)} has already passed in this interval, so saving now makes the turn due right away
          {ready ? '' : ' (nothing is ready, so the timer just restarts)'}.
        </p>
      )}
      {confirming && (
        <div className="adm-confirm" role="group" aria-label="Confirm: Requests only">
          <span className="adm-warning">{interruption}</span>
          <Button variant="solid" className="adm-danger" data-adm-confirm-requests-only="true">
            Switch to Requests only
          </Button>
          <Button variant="outline" data-adm-cancel-requests-only="true">
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ queues

function MoveButtons({
  queue,
  entryId,
  index,
  length,
}: {
  queue: 'master' | 'request';
  entryId: string;
  index: number;
  length: number;
}) {
  return (
    <>
      <Button
        variant="ghost"
        className="adm-icon"
        icon="arrow-up"
        disabled={index === 0}
        aria-label="Move up"
        data-adm-move-queue={queue}
        data-adm-move-id={entryId}
        data-adm-move-dir="up"
      />
      <Button
        variant="ghost"
        className="adm-icon"
        icon="arrow-down"
        disabled={index === length - 1}
        aria-label="Move down"
        data-adm-move-queue={queue}
        data-adm-move-id={entryId}
        data-adm-move-dir="down"
      />
    </>
  );
}

const REQUEST_TAG: Partial<Record<RequestEntryView['status'], [Tone, string]>> = {
  preparing: ['warn', 'loading'],
  playing: ['ok', 'playing'],
  failed: ['bad', 'failed'],
};

function PlayNowButton({
  snapshot,
  request,
  armed,
}: {
  snapshot: Snapshot;
  request: RequestEntryView;
  armed: boolean;
}) {
  const open = snapshot.night?.status === 'open';
  const requestPlaying = !!playingRequest(snapshot);
  const current = snapshot.schedule.phase === 'master' ? snapshot.nowPlaying : null;
  const reason = !open
    ? 'Start the night first'
    : request.status !== 'ready'
      ? 'Still loading'
      : requestPlaying
        ? 'A request is playing. Move this one to the top to play it next.'
        : undefined;
  const effects = [
    current ? `Interrupts “${current.title}”; it resumes where it left off afterward.` : 'Starts right away.',
    snapshot.schedule.intent === 'paused' ? 'Playback is paused, so press Play to hear it.' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <ConfirmButton
      quiet
      danger={false}
      label="Play now…"
      confirmLabel="Play now"
      warning={effects}
      disabled={!!reason}
      title={reason}
      armed={armed}
      confirmId={`request-playNow:${request.id}`}
    />
  );
}

export function RequestQueuePanel({
  snapshot,
  armedId = null,
}: {
  snapshot: Snapshot;
  actions?: Actions;
  armedId?: string | null;
}) {
  const playing = playingRequest(snapshot);
  const waiting = waitingRequests(snapshot);
  const row = (r: RequestEntryView, index: number) => {
    const t = REQUEST_TAG[r.status];
    const rowActions =
      r.status !== 'playing'
        ? [
            <MoveButtons key="m" queue="request" entryId={r.id} index={index} length={waiting.length} />,
            <PlayNowButton key="p" snapshot={snapshot} request={r} armed={armedId === `request-playNow:${r.id}`} />,
          ]
        : null;
    const sub = `${r.artist ?? 'Unknown artist'} · ${time(r.durationSec)} · from ${r.requester ?? 'unknown'}`;
    return (
      <li key={r.id} className={`adm-row${r.status === 'playing' ? ' adm-current' : ''}`} data-entry={r.id} data-status={r.status}>
        <span className="adm-num">{index < 0 ? '▶' : index + 1}</span>
        <div className="adm-row-main">
          <span className="adm-row-title">{r.title}</span>
          <span className="adm-dim adm-small">{sub}</span>
          {r.error && <span className="adm-bad-text adm-small">{r.error}</span>}
        </div>
        {t && tag(t[0], t[1])}
        <div className="adm-row-actions">
          {rowActions}
          <ConfirmButton
            quiet
            label="Remove…"
            confirmLabel="Remove"
            armed={armedId === `request-remove:${r.id}`}
            confirmId={`request-remove:${r.id}`}
            warning={
              r.status === 'playing'
                ? 'Stops this request now; master music resumes. They don’t get the request back.'
                : 'They don’t get the request back.'
            }
          />
        </div>
      </li>
    );
  };
  return (
    <Panel
      title="Requests queue"
      id="adm-requests"
      aside={<span className="adm-dim adm-small">{waiting.length} waiting</span>}
    >
      {playing || waiting.length ? (
        <ul className="adm-list" aria-label="Request items">
          {playing && row(playing, -1)}
          {waiting.map(row)}
        </ul>
      ) : (
        <p className="adm-empty">{snapshot.night?.status === 'open' ? 'No requests yet.' : 'Requests open when the night starts.'}</p>
      )}
    </Panel>
  );
}

const MASTER_TAG: Partial<Record<MasterEntryView['status'], [Tone, string]>> = {
  preparing: ['warn', 'loading'],
  failed: ['bad', 'failed'],
  unusable: ['bad', 'can’t play'],
};

export function MasterQueuePanel({
  snapshot,
  armedId = null,
}: {
  snapshot: Snapshot;
  actions?: Actions;
  armedId?: string | null;
}) {
  const master = snapshot.master ?? [];
  const currentId =
    snapshot.schedule.phase === 'master' ? snapshot.nowPlaying?.entryId : snapshot.suspendedMaster?.entryId;
  const row = (m: MasterEntryView, index: number) => {
    const isCurrent = m.id === currentId;
    const suspended = snapshot.suspendedMaster?.entryId === m.id;
    const t = MASTER_TAG[m.status] ?? (m.status === 'ready' ? null : (['dim', m.status] as [Tone, string]));
    const sub = `${m.artist ?? 'Unknown artist'} · ${time(m.durationSec)}${m.isMix ? ' · mix' : ''}`;
    return (
      <li key={m.id} className={`adm-row${isCurrent ? ' adm-current' : ''}`} data-entry={m.id} data-status={m.status}>
        <span className="adm-num">{isCurrent ? (suspended ? '❚❚' : '▶') : index + 1}</span>
        <div className="adm-row-main">
          <span className="adm-row-title">{m.title}</span>
          <span className="adm-dim adm-small">{sub}</span>
        </div>
        {t && tag(t[0], t[1])}
        <div className="adm-row-actions">
          <MoveButtons queue="master" entryId={m.id} index={index} length={master.length} />
          <ConfirmButton
            quiet
            label="Remove…"
            confirmLabel="Remove"
            armed={armedId === `master-remove:${m.id}`}
            confirmId={`master-remove:${m.id}`}
            warning={
              suspended
                ? 'This mix is waiting to resume; the next song plays instead.'
                : isCurrent
                  ? 'This is playing now; it jumps to the next song.'
                  : undefined
            }
          />
        </div>
      </li>
    );
  };
  return (
    <Panel
      title="Master queue"
      id="adm-master"
      aside={
        <span className="adm-dim adm-small">
          {master.length} song{master.length === 1 ? '' : 's'}
        </span>
      }
    >
      {master.length ? (
        <ul className="adm-list" aria-label="Master items">
          {master.map(row)}
        </ul>
      ) : (
        <p className="adm-empty">Empty. Paste a link above and press Add to master.</p>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------- add

export function AddBarStatus({
  lastAdd,
  blocked,
  target,
}: {
  lastAdd: Intent | null;
  blocked: boolean;
  target: 'master' | 'request' | null;
}) {
  return (
    <>
      {blocked && (
        <p className="adm-add-loading adm-small" role="status">
          <span className="adm-spinner" aria-hidden="true" />
          Adding to {target === 'master' ? 'master' : 'requests'}…
        </p>
      )}
      {lastAdd?.status === 'failed' && lastAdd.error && (
        <p className="adm-bad-text adm-small" role="alert" data-testid="add-error">
          {explainError(lastAdd.error, lastAdd.type).message}
        </p>
      )}
    </>
  );
}

export function AddBar({
  lastAdd,
  nightOpen,
  children,
  url = '',
  submitting = null,
  onUrlChange,
  onSubmitMaster,
  onAddRequest,
}: {
  actions?: Actions;
  lastAdd: Intent | null;
  nightOpen: boolean;
  children?: ReactNode;
  url?: string;
  submitting?: 'master' | 'request' | null;
  onUrlChange?: (value: string) => void;
  onSubmitMaster?: () => void;
  onAddRequest?: () => void;
}) {
  const pending = lastAdd?.status === 'pending';
  const blocked = pending || submitting !== null;
  const target = pending ? (lastAdd.type === 'master.add' ? 'master' : 'request') : submitting;
  const value = url.trim();
  return (
    <section className="adm-section" aria-labelledby="adm-queue">
      <h2 id="adm-queue" className="adm-headline adm-section-title">
        Queue
      </h2>
      <Card className="adm-card">
        <form
          className="adm-add"
          aria-busy={blocked ? 'true' : 'false'}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitMaster?.();
          }}
        >
          <Field label="YouTube, Spotify, Apple Music, or Deezer track link" htmlFor="adm-add-url">
            <div className="adm-add-row">
              <Input
                id="adm-add-url"
                type="url"
                inputMode="url"
                value={url}
                disabled={blocked}
                onChange={(event) => onUrlChange?.(event.target.value)}
              />
              <Button type="submit" variant="solid" data-adm-add-master="true" disabled={!value || blocked}>
                Add to master
              </Button>
              <Tip title={nightOpen ? undefined : 'Start the night first'}>
                <Button
                  variant="outline"
                  data-adm-add-request="true"
                  disabled={!value || !nightOpen || blocked}
                  onClick={() => onAddRequest?.()}
                >
                  Add to requests
                </Button>
              </Tip>
            </div>
            <AddBarStatus lastAdd={lastAdd} blocked={blocked} target={target} />
          </Field>
        </form>
        {children}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------- activity

export function ActivityPanel({
  intents,
  hidden = false,
  activity = [],
  actorName,
}: {
  intents: readonly Intent[];
  actions?: Actions;
  hidden?: boolean;
  activity?: readonly QueueActivityEntry[];
  actorName?: string;
}) {
  const logged = new Set(activity.map((entry) => entry.id));
  const accepted: Intent[] = activity.map((entry) => ({
    id: entry.id,
    label: `${entry.username} added “${entry.title}” to ${entry.queue} queue`,
    type: entry.queue === 'master' ? 'master.add' : 'request.submit',
    payload: {},
    status: 'ok',
    error: null,
    replayed: false,
    startedAt: entry.at,
    finishedAt: entry.at,
    attempts: 1,
  }));
  const local = intents
    .filter((i) => !logged.has(i.id) && (i.type !== 'playback.volume' || i.status === 'failed'))
    .map((intent) => ({
      ...intent,
      label: actorName ? `${actorName} — ${intent.label}` : intent.label,
    }));
  const visible = [...accepted, ...local].sort((a, b) => b.startedAt - a.startedAt).slice(0, 24);

  return (
    <section id="adm-activity" className="adm-section" aria-labelledby="adm-activity-title" hidden={hidden}>
      <h2 id="adm-activity-title" className="adm-headline adm-section-title">
        Action log
      </h2>
      <Card className="adm-card">
        <div className="adm-activity">
          {!visible.length && <p className="adm-empty">No actions yet.</p>}
          <ul className="adm-list" aria-label="Action log">
            {visible.map((intent) => {
              const explained = intent.error ? explainError(intent.error, intent.type) : null;
              const [tone, label]: [Tone, string] =
                intent.status === 'ok'
                  ? ['ok', 'sent']
                  : intent.status === 'pending'
                    ? ['warn', 'sending…']
                    : explained?.tone === 'conflict'
                      ? ['warn', 'not applied']
                      : ['bad', 'failed'];
              const d = new Date(intent.startedAt);
              const titleStr = d.toLocaleString([], { timeZone: 'America/Indiana/Indianapolis' });
              const timeStr = d.toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                timeZone: 'America/Indiana/Indianapolis',
              });
              return (
                <li key={intent.id} className="adm-row" data-status={intent.status} data-intent={intent.type}>
                  <time className="adm-action-time adm-dim" dateTime={d.toISOString()} title={titleStr}>
                    {timeStr}
                  </time>
                  <div className="adm-row-main">
                    <span>{intent.label}</span>
                    {intent.status === 'failed' && explained && (
                      <span
                        className={`adm-small ${explained.tone === 'transient' ? 'adm-warning' : 'adm-bad-text'}`}
                        role="alert"
                      >
                        {explained.message}
                      </span>
                    )}
                    {intent.status === 'ok' && intent.replayed && <span className="adm-dim adm-small">Already applied earlier.</span>}
                  </div>
                  {tag(tone, label)}
                  {intent.status === 'failed' && intent.error?.retryable && (
                    <Button variant="ghost" data-adm-retry={intent.id}>
                      Retry
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </Card>
    </section>
  );
}
