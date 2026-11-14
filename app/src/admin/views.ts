// Presentational admin views as pure HTML builders. Props in, HTML strings out: no fetching or
// browser globals required, so unit/SSR tests render live snapshots directly with Bun.
import type {
  MasterEntryView,
  QueueActivityEntry,
  QueueMode,
  RequestEntryView,
  Snapshot,
} from '../../../src/contract/types.ts';
import {
  escapeHtml,
  renderBadge,
  renderButton,
  renderCard,
  renderDitherButton,
  renderField,
  renderIcon,
  renderInput,
  type BadgeColor,
} from '../components/ph/html.ts';
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
  setInterval(periodMs: number | null): Done;
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

function tip(title: string | undefined, children: string): string {
  return title ? `<span class="adm-tip" title="${escapeHtml(title)}">${children}</span>` : children;
}

function panel({ title, id, children, aside }: { title: string; id: string; children: string; aside?: string }): string {
  const card = renderCard({
    className: 'adm-card',
    children: `<header class="adm-panel-head"><h2 id="${escapeHtml(id)}" class="adm-headline adm-panel-title">${escapeHtml(title)}</h2>${aside ?? ''}</header>${children}`,
  });
  return `<section class="adm-panel" aria-labelledby="${escapeHtml(id)}">${card}</section>`;
}

const tag = (tone: Tone, label: string) =>
  renderBadge({ color: TONE_BADGE[tone], children: escapeHtml(label) });

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
}): string {
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
    return tip(
      title,
      renderButton({
        variant: quiet ? 'ghost' : 'outline',
        disabled,
        attrs: {
          'data-confirm-arm': confirmId,
          'data-confirm-context': context,
        },
        children: escapeHtml(label),
      }),
    );
  }
  const warningHtml = warning ? `<span class="adm-warning">${escapeHtml(warning)}</span>` : '';
  const confirmBtn = renderButton({
    variant: 'solid',
    className: danger ? 'adm-danger' : undefined,
    attrs: {
      'data-confirm-exec': confirmId,
      'data-confirm-context': context,
    },
    children: escapeHtml(confirmLabel),
  });
  const cancelBtn = renderButton({
    variant: 'outline',
    attrs: { 'data-confirm-cancel': confirmId },
    children: 'Cancel',
  });
  return `<span class="adm-confirm" role="group" aria-label="${escapeHtml(`Confirm: ${label}`)}">${warningHtml}${confirmBtn}${cancelBtn}</span>`;
}

// ------------------------------------------------------------------ access

function gate(busy: boolean, children: string): string {
  const busyAttr = busy ? ' aria-busy="true"' : '';
  const card = renderCard({ className: 'adm-card adm-gate', children });
  return `<main class="ph-ui dark adm-root"${busyAttr}><div class="adm-shell">${card}</div></main>`;
}

export function AccessGateCard(access: Exclude<Access, { state: 'admin' }>): { busy: boolean; html: string } {
  if (access.state === 'loading') {
    return { busy: true, html: renderCard({ className: 'adm-card adm-gate', children: '<p>Checking your sign-in…</p>' }) };
  }
  if (access.state === 'signed_out') {
    const title = access.expired ? 'Session expired' : 'Organizer sign-in';
    const copy = access.expired
      ? 'Your sign-in expired. Nothing you tried since then was applied. Sign in again to keep going.'
      : 'Sign in with Purdue Hackers ID. Only organizers can control the jukebox.';
    const btn = renderDitherButton({ href: '/auth/login?returnTo=/admin', children: 'Sign in' });
    return {
      busy: false,
      html: renderCard({
        className: 'adm-card adm-gate',
        children: `<h1 class="adm-headline adm-h1">${title}</h1><p>${copy}</p>${btn}`,
      }),
    };
  }
  const checkAgain = renderDitherButton({ href: '/auth/login?returnTo=/admin', children: 'Check again' });
  const otherAccount = renderButton({
    variant: 'outline',
    size: 'lg',
    href: '/auth/login?returnTo=/admin',
    children: 'Use a different account',
  });
  return {
    busy: false,
    html: renderCard({
      className: 'adm-card adm-gate',
      children: `<h1 class="adm-headline adm-h1">Organizer access required</h1><p>You are signed in as <strong>${escapeHtml(access.name)}</strong>, but this sign-in doesn’t include organizer access. If your PH ID access changed recently, check again to refresh it.</p><div class="adm-gate-actions">${checkAgain}${otherAccount}</div>`,
    }),
  };
}

export function AccessGate({ access }: { access: Exclude<Access, { state: 'admin' }>; onRetry?: () => void }): string {
  if (access.state === 'loading') return gate(true, '<p>Checking your sign-in…</p>');
  if (access.state === 'signed_out') {
    const title = access.expired ? 'Session expired' : 'Organizer sign-in';
    const copy = access.expired
      ? 'Your sign-in expired. Nothing you tried since then was applied. Sign in again to keep going.'
      : 'Sign in with Purdue Hackers ID. Only organizers can control the jukebox.';
    const btn = renderDitherButton({ href: '/auth/login?returnTo=/admin', children: 'Sign in' });
    return gate(false, `<h1 class="adm-headline adm-h1">${title}</h1><p>${copy}</p>${btn}`);
  }
  const checkAgain = renderDitherButton({ href: '/auth/login?returnTo=/admin', children: 'Check again' });
  const otherAccount = renderButton({
    variant: 'outline',
    size: 'lg',
    href: '/auth/login?returnTo=/admin',
    children: 'Use a different account',
  });
  return gate(
    false,
    `<h1 class="adm-headline adm-h1">Organizer access required</h1><p>You are signed in as <strong>${escapeHtml(access.name)}</strong>, but this sign-in doesn’t include organizer access. If your PH ID access changed recently, check again to refresh it.</p><div class="adm-gate-actions">${checkAgain}${otherAccount}</div>`,
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
}): string {
  const tone = link === 'live' ? 'ok' : link === 'connecting' ? 'info' : 'bad';
  const label = link === 'live' ? 'Live' : link === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  const titleAttr = linkError ? ` title="${escapeHtml(linkError)}"` : '';
  const signOutBtn = renderButton({
    variant: 'ghost',
    attrs: { 'data-adm-sign-out': 'true' },
    children: 'Sign out',
  });
  return `<span class="adm-link adm-${tone}"${titleAttr}><span class="adm-dot" aria-hidden="true"></span>${label}</span><span class="adm-dim">${escapeHtml(name)}</span>${signOutBtn}`;
}

export function Header({
  name,
  link,
  linkError,
  children = '',
}: {
  name: string;
  link: Link;
  linkError: string | null;
  onSignOut?: () => void;
  children?: string;
}): string {
  return `<header class="adm-header"><h1 class="adm-headline adm-h1">Jukebox</h1>${children}<div class="adm-header-meta">${HeaderMeta({ name, link, linkError })}</div></header>`;
}

const alertIcon = () => renderIcon({ name: 'exclamation-triangle', className: 'adm-alert-icon' });

export function AlertsBand({
  snapshot,
  link,
  external,
}: {
  snapshot: Snapshot;
  link: Link;
  external: boolean;
  onAckExternal?: () => void;
}): string {
  const items: string[] = [];
  if (link === 'reconnecting') {
    items.push(
      `<li class="adm-alert adm-bad"><span class="adm-alert-text">${alertIcon()}Connection to the jukebox service was lost. What you see may be out of date until it reconnects.</span></li>`,
    );
  }
  for (const alert of snapshot.alerts) {
    if (alert.code === 'unconfirmed_command') continue; // Delayed inline indicator owns acknowledgement feedback.
    items.push(
      `<li class="adm-alert ${alert.code === 'player_offline' ? 'adm-bad' : 'adm-warn'}" data-alert="${escapeHtml(alert.code)}"><span class="adm-alert-text">${alertIcon()}${escapeHtml(alert.message)}</span></li>`,
    );
  }
  if (external) {
    const okBtn = renderButton({
      variant: 'outline',
      attrs: { 'data-adm-ack-external': 'true' },
      children: 'OK',
    });
    items.push(
      `<li class="adm-alert adm-info" data-alert="external_change"><span class="adm-alert-text">Someone else changed a queue. The lists are up to date.</span>${okBtn}</li>`,
    );
  }
  if (!items.length) return '';
  return `<ul class="adm-alerts" role="status" aria-live="polite">${items.join('')}</ul>`;
}

// ------------------------------------------------------------------- night

export function NightPanel({
  snapshot,
  armed = false,
}: {
  snapshot: Snapshot;
  actions?: Actions;
  armed?: boolean;
}): string {
  const open = snapshot.night?.status === 'open';
  const waiting = waitingRequests(snapshot).length;
  const playing = playingRequest(snapshot);
  const content = open
    ? ConfirmButton({
        label: 'End night…',
        confirmLabel: 'End night',
        context: snapshot.revision,
        armed,
        confirmId: 'night-close',
        warning: `Stops the music, closes requests, and clears ${waiting} waiting request${waiting === 1 ? '' : 's'}${playing ? ` and “${playing.title}”` : ''}. Nobody gets requests back.`,
      })
    : renderDitherButton({
        attrs: { 'data-adm-night-open': 'true' },
        children: 'Start night',
      });
  return `<div class="adm-night" id="adm-night" data-open="${open}">${content}</div>`;
}

export function BanListItems(bannedUsernames: readonly string[] = []): string {
  if (!bannedUsernames.length) {
    return '<li class="adm-dim adm-small">No banned usernames.</li>';
  }
  return bannedUsernames
    .map((name) => {
      const btn = renderButton({
        variant: 'ghost',
        size: 'sm',
        attrs: { 'data-adm-unban': name },
        children: 'Unban',
      });
      return `<li><span>${escapeHtml(name)}</span>${btn}</li>`;
    })
    .join('');
}

export function BanMenu({
  snapshot,
  open = false,
  username = '',
}: {
  snapshot: Snapshot;
  actions?: Actions;
  open?: boolean;
  username?: string;
}): string {
  const trigger = renderButton({
    variant: 'outline',
    attrs: {
      'aria-expanded': String(open),
      'aria-controls': 'adm-ban-submenu',
      'aria-haspopup': 'dialog',
      'data-adm-ban-toggle': 'true',
    },
    children: 'Ban…',
  });
  let submenu = '';
  if (open) {
    const valid = /^[a-zA-Z0-9._-]{1,40}$/.test(username.trim());
    const field = renderField({
      label: 'PH ID username',
      forId: 'adm-ban-username',
      hint: 'Letters, numbers, dot, underscore or hyphen.',
      children: renderInput({
        attrs: {
          id: 'adm-ban-username',
          autocomplete: 'off',
          maxlength: 40,
          value: username,
        },
      }),
    });
    const submitBtn = renderButton({
      type: 'submit',
      disabled: !valid,
      attrs: { 'data-adm-ban-submit': 'true' },
      children: 'Ban username',
    });
    const card = renderCard({
      className: 'adm-ban-submenu',
      children: `<h2 class="ph-subheadline">Request bans</h2><p class="adm-small">Blocks new submissions by this PH ID username. Existing requests stay in the queue.</p><form class="adm-ban-form" data-adm-ban-form>${field}${submitBtn}</form><ul class="adm-ban-list" aria-label="Banned usernames">${BanListItems(snapshot.bannedUsernames ?? [])}</ul>`,
    });
    submenu = `<div id="adm-ban-submenu">${card}</div>`;
  }
  return `<div class="adm-ban-menu">${trigger}${submenu}</div>`;
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

export function DisplayWait({ waiting, delayed = false }: { waiting: boolean; delayed?: boolean }): string {
  const hiddenAttr = !waiting || !delayed ? ' hidden=""' : '';
  return `<span class="adm-display-wait" role="status"${hiddenAttr} title="Still waiting for the display. Check its connection."><span class="adm-spinner" aria-hidden="true"></span><span class="adm-sr">Still waiting for the display. Check its connection.</span></span>`;
}

export function NowPlayingPanel({
  snapshot,
  serverNow,
  pendingVolume,
  intents = [],
  children = '',
  dragging = null,
  displayDelayed = false,
  armedSkip = false,
}: {
  intents?: readonly Intent[];
  snapshot: Snapshot;
  serverNow: number;
  actions?: Actions;
  pendingVolume: number | null;
  children?: string;
  dragging?: number | null;
  displayDelayed?: boolean;
  armedSkip?: boolean;
}): string {
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

  const artClass = `adm-art${now?.artworkUrl ? '' : ' dither-field'}`;
  const artInner = now?.artworkUrl ? `<img src="${escapeHtml(now.artworkUrl)}" alt="" />` : '';

  let trackTextHtml: string;
  if (now) {
    const kindBadge = renderBadge({
      className: 'adm-kind',
      color: now.kind === 'master' ? 'purple' : 'yellow',
      children: now.kind === 'master' ? 'Master queue' : 'Request',
    });
    const metaText = `${now.artist ?? 'Unknown artist'}${request?.requester ? ` · requested by ${request.requester}` : ''}`;
    const resumedLine = snapshot.suspendedMaster
      ? `<p class="adm-dim adm-small">“${escapeHtml(snapshot.suspendedMaster.title)}” resumes at ${escapeHtml(time(snapshot.suspendedMaster.positionSec))} after this.</p>`
      : '';
    trackTextHtml = `<p class="adm-headline adm-now-title" data-testid="now-title">${escapeHtml(now.title)}</p><p class="adm-meta">${kindBadge}<span class="adm-dim">${escapeHtml(metaText)}</span></p>${resumedLine}`;
  } else if (snapshot.schedule.requestsIdle) {
    const reqBadge = renderBadge({ className: 'adm-kind', color: 'yellow', children: 'Requests only' });
    const resumedLine = snapshot.suspendedMaster
      ? `<p class="adm-dim adm-small">“${escapeHtml(snapshot.suspendedMaster.title)}” resumes at ${escapeHtml(time(snapshot.suspendedMaster.positionSec))} when you switch back.</p>`
      : '';
    trackTextHtml = `<p class="adm-headline adm-now-title adm-dim">Waiting for requests.</p><p class="adm-meta">${reqBadge}</p>${resumedLine}`;
  } else {
    trackTextHtml = '<p class="adm-headline adm-now-title adm-dim">Nothing playing. Add songs to the master queue.</p>';
  }

  const seekMax = Math.max(1, Math.floor(position.durationSec ?? 1));
  const seekVal = Math.floor(shownPosition);
  const seekDisabled = !now || position.durationSec === null ? ' disabled=""' : '';
  const posLabel = time(position.positionSec === null && dragging === null ? null : shownPosition);

  const replayBtn = renderButton({
    variant: 'outline',
    className: 'adm-icon',
    icon: 'refresh',
    disabled: !now,
    attrs: {
      'aria-label': 'Restart song',
      title: 'Restart song',
      'data-adm-replay': now?.entryId,
    },
    children: '',
  });
  const backBtn = renderButton({
    variant: 'outline',
    className: 'adm-icon',
    disabled: !canSeek,
    attrs: {
      'aria-label': 'Back 15 seconds',
      title: 'Back 15 s',
      'data-adm-seek-rel': '-15',
      'data-adm-entry': now?.entryId,
    },
    children: '−15',
  });
  const playPauseBtn = playing
    ? renderDitherButton({
        className: 'adm-play',
        attrs: { 'data-adm-pause': 'true' },
        children: 'Pause',
      })
    : renderDitherButton({
        className: 'adm-play',
        disabled: snapshot.night?.status !== 'open',
        attrs: { 'data-adm-play': 'true' },
        children: 'Play',
      });
  const fwdBtn = renderButton({
    variant: 'outline',
    className: 'adm-icon',
    disabled: !canSeek,
    attrs: {
      'aria-label': 'Forward 15 seconds',
      title: 'Forward 15 s',
      'data-adm-seek-rel': '15',
      'data-adm-entry': now?.entryId,
    },
    children: '+15',
  });
  const skipBtn = now
    ? ConfirmButton({
        label: 'Skip…',
        confirmLabel: 'Skip',
        armed: armedSkip,
        confirmId: 'skip-now',
        warning:
          now.kind === 'request'
            ? 'Ends this request without giving it back; master music resumes.'
            : 'Jumps to the next master song. The request timer keeps going.',
      })
    : renderButton({ variant: 'outline', disabled: true, children: 'Skip…' });

  const volPct = Math.round(volume * 100);
  const waitHtml = DisplayWait({
    waiting: confirmation === 'requested' || confirmation === 'unconfirmed',
    delayed: displayDelayed,
  });
  const hintHtml = status.hint ? `<span class="adm-status-hint">${escapeHtml(status.hint)}</span>` : '';

  const cardBody = `<div class="adm-track"><div class="${artClass}" aria-hidden="true">${artInner}</div><div class="adm-track-text">${trackTextHtml}</div></div><div class="adm-progress"><input id="adm-seek" type="range" aria-label="Seek" min="0" max="${seekMax}" step="1" value="${seekVal}"${seekDisabled} /><div class="adm-times"><span data-testid="position">${escapeHtml(posLabel)}</span><span data-adm-duration>${escapeHtml(time(position.durationSec))}</span></div></div><div class="adm-transport">${replayBtn}${backBtn}${playPauseBtn}${fwdBtn}${skipBtn}<label class="adm-volume" for="adm-volume"><span aria-hidden="true">Vol</span><input id="adm-volume" type="range" aria-label="Volume" min="0" max="100" step="1" value="${volPct}" /><span data-testid="volume">${volPct}%</span></label></div><div class="adm-status adm-${status.tone}"><span class="adm-dot" aria-hidden="true"></span><span data-testid="player-state">${escapeHtml(PLAYER_LABEL[state])}</span><span data-testid="confirmation" data-confirmation="${lapsed ? 'lapsed' : escapeHtml(confirmation)}" hidden=""></span>${waitHtml}${hintHtml}</div>${children}`;

  const card = renderCard({ className: 'adm-card adm-player', children: cardBody });
  return `<section class="adm-section" aria-labelledby="adm-now"><h2 id="adm-now" class="adm-headline adm-section-title">Now playing</h2>${card}</section>`;
}

// ------------------------------------------------------------- request turn

export function TurnPanel({ snapshot, serverNow }: { snapshot: Snapshot; serverNow: number }): string {
  const turn = describeTurn(snapshot, serverNow);
  if (turn.kind === 'in_request') return '';
  return `<div class="adm-turn" id="adm-turn" data-kind="${escapeHtml(turn.kind)}"><strong data-testid="turn-headline">${escapeHtml(turn.headline)}</strong></div>`;
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
}: {
  snapshot: Snapshot;
  serverNow: number;
  actions?: Actions;
  intents?: readonly Intent[];
  draft?: string;
  confirming?: boolean;
}): string {
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
      ? serverNow - schedule.periodStartedAt
      : null;
  const alreadyElapsed = valid && elapsedMs !== null && elapsedMs >= minutes * 60_000;

  const radioButtons = MODES.map((m) => {
    const unavailable = m.mode === 'requests' && !open;
    const btn = renderButton({
      variant: 'outline',
      disabled: unavailable,
      className: `adm-seg-btn${mode === m.mode ? ' adm-selected' : ''}`,
      attrs: {
        role: 'radio',
        'aria-checked': String(mode === m.mode),
        'data-mode': m.mode,
      },
      children: escapeHtml(m.label),
    });
    return tip(unavailable ? 'Start the night first' : m.help, btn);
  }).join('');

  const intervalField = renderField({
    label: 'Request every',
    forId: 'adm-interval',
    children: `<div class="adm-interval-row">${renderInput({
      attrs: {
        id: 'adm-interval',
        type: 'number',
        inputmode: 'numeric',
        min: minMinutes,
        max: maxMinutes,
        step: 1,
        value: draft,
        'aria-invalid': draft !== '' && !valid ? 'true' : undefined,
      },
    })}<span aria-hidden="true">min</span>${renderButton({
      type: 'submit',
      variant: 'outline',
      disabled: !valid || minutes === currentMinutes,
      attrs: { 'data-adm-interval-set': 'true' },
      children: 'Set',
    })}</div>`,
  });

  const invalidWarning =
    !valid && draft !== ''
      ? `<p class="adm-warning adm-small" role="alert">Use a whole number from ${minMinutes} to ${maxMinutes} minutes.</p>`
      : '';
  const elapsedWarning = alreadyElapsed
    ? `<p class="adm-warning adm-small" data-testid="interval-warning">${escapeHtml(formatClock(elapsedMs!))} has already passed in this interval, so saving now makes the turn due right away${ready ? '' : ' (nothing is ready, so the timer just restarts)'}.</p>`
    : '';
  const confirmBox = confirming
    ? `<div class="adm-confirm" role="group" aria-label="Confirm: Requests only"><span class="adm-warning">${escapeHtml(interruption)}</span>${renderButton({
        variant: 'solid',
        className: 'adm-danger',
        attrs: { 'data-adm-confirm-requests-only': 'true' },
        children: 'Switch to Requests only',
      })}${renderButton({
        variant: 'outline',
        attrs: { 'data-adm-cancel-requests-only': 'true' },
        children: 'Cancel',
      })}</div>`
    : '';

  return `<div class="adm-qc" id="adm-queue-control"><div class="adm-qc-row"><div class="adm-seg" role="radiogroup" aria-label="Play from">${radioButtons}</div><form class="adm-interval" data-adm-interval-form>${intervalField}</form></div>${invalidWarning}${elapsedWarning}${confirmBox}</div>`;
}

// ------------------------------------------------------------------ queues

function moveButtons({
  queue,
  entryId,
  index,
  length,
}: {
  queue: 'master' | 'request';
  entryId: string;
  index: number;
  length: number;
}): string {
  const up = renderButton({
    variant: 'ghost',
    className: 'adm-icon',
    icon: 'arrow-up',
    disabled: index === 0,
    attrs: {
      'aria-label': 'Move up',
      'data-adm-move-queue': queue,
      'data-adm-move-id': entryId,
      'data-adm-move-dir': 'up',
    },
    children: '',
  });
  const down = renderButton({
    variant: 'ghost',
    className: 'adm-icon',
    icon: 'arrow-down',
    disabled: index === length - 1,
    attrs: {
      'aria-label': 'Move down',
      'data-adm-move-queue': queue,
      'data-adm-move-id': entryId,
      'data-adm-move-dir': 'down',
    },
    children: '',
  });
  return `${up}${down}`;
}

const REQUEST_TAG: Partial<Record<RequestEntryView['status'], [Tone, string]>> = {
  preparing: ['warn', 'loading'],
  playing: ['ok', 'playing'],
  failed: ['bad', 'failed'],
};

function playNowButton({
  snapshot,
  request,
  armed,
}: {
  snapshot: Snapshot;
  request: RequestEntryView;
  armed: boolean;
}): string {
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
  return ConfirmButton({
    quiet: true,
    danger: false,
    label: 'Play now…',
    confirmLabel: 'Play now',
    warning: effects,
    disabled: !!reason,
    title: reason,
    armed,
    confirmId: `request-playNow:${request.id}`,
  });
}

export function RequestQueuePanel({
  snapshot,
  armedId = null,
}: {
  snapshot: Snapshot;
  actions?: Actions;
  armedId?: string | null;
}): string {
  const playing = playingRequest(snapshot);
  const waiting = waitingRequests(snapshot);
  const row = (r: RequestEntryView, index: number) => {
    const t = REQUEST_TAG[r.status];
    const rowActions =
      r.status !== 'playing'
        ? `${moveButtons({ queue: 'request', entryId: r.id, index, length: waiting.length })}${playNowButton({ snapshot, request: r, armed: armedId === `request-playNow:${r.id}` })}`
        : '';
    const removeBtn = ConfirmButton({
      quiet: true,
      label: 'Remove…',
      confirmLabel: 'Remove',
      armed: armedId === `request-remove:${r.id}`,
      confirmId: `request-remove:${r.id}`,
      warning:
        r.status === 'playing'
          ? 'Stops this request now; master music resumes. They don’t get the request back.'
          : 'They don’t get the request back.',
    });
    const errorLine = r.error ? `<span class="adm-bad-text adm-small">${escapeHtml(r.error)}</span>` : '';
    const sub = `${r.artist ?? 'Unknown artist'} · ${time(r.durationSec)} · from ${r.requester ?? 'unknown'}`;
    return `<li class="adm-row${r.status === 'playing' ? ' adm-current' : ''}" data-entry="${escapeHtml(r.id)}" data-status="${escapeHtml(r.status)}"><span class="adm-num">${index < 0 ? '▶' : index + 1}</span><div class="adm-row-main"><span class="adm-row-title">${escapeHtml(r.title)}</span><span class="adm-dim adm-small">${escapeHtml(sub)}</span>${errorLine}</div>${t ? tag(t[0], t[1]) : ''}<div class="adm-row-actions">${rowActions}${removeBtn}</div></li>`;
  };
  const body =
    playing || waiting.length
      ? `<ul class="adm-list" aria-label="Request items">${playing ? row(playing, -1) : ''}${waiting.map(row).join('')}</ul>`
      : `<p class="adm-empty">${snapshot.night?.status === 'open' ? 'No requests yet.' : 'Requests open when the night starts.'}</p>`;
  return panel({
    title: 'Requests queue',
    id: 'adm-requests',
    aside: `<span class="adm-dim adm-small">${waiting.length} waiting</span>`,
    children: body,
  });
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
}): string {
  const master = snapshot.master ?? [];
  const currentId =
    snapshot.schedule.phase === 'master' ? snapshot.nowPlaying?.entryId : snapshot.suspendedMaster?.entryId;
  const row = (m: MasterEntryView, index: number) => {
    const isCurrent = m.id === currentId;
    const suspended = snapshot.suspendedMaster?.entryId === m.id;
    const t = MASTER_TAG[m.status] ?? (m.status === 'ready' ? null : (['dim', m.status] as [Tone, string]));
    const sub = `${m.artist ?? 'Unknown artist'} · ${time(m.durationSec)}${m.isMix ? ' · mix' : ''}`;
    const moves = moveButtons({ queue: 'master', entryId: m.id, index, length: master.length });
    const removeBtn = ConfirmButton({
      quiet: true,
      label: 'Remove…',
      confirmLabel: 'Remove',
      armed: armedId === `master-remove:${m.id}`,
      confirmId: `master-remove:${m.id}`,
      warning: suspended
        ? 'This mix is waiting to resume; the next song plays instead.'
        : isCurrent
          ? 'This is playing now; it jumps to the next song.'
          : undefined,
    });
    return `<li class="adm-row${isCurrent ? ' adm-current' : ''}" data-entry="${escapeHtml(m.id)}" data-status="${escapeHtml(m.status)}"><span class="adm-num">${isCurrent ? (suspended ? '❚❚' : '▶') : index + 1}</span><div class="adm-row-main"><span class="adm-row-title">${escapeHtml(m.title)}</span><span class="adm-dim adm-small">${escapeHtml(sub)}</span></div>${t ? tag(t[0], t[1]) : ''}<div class="adm-row-actions">${moves}${removeBtn}</div></li>`;
  };
  const body = master.length
    ? `<ul class="adm-list" aria-label="Master items">${master.map(row).join('')}</ul>`
    : '<p class="adm-empty">Empty. Paste a link above and press Add to master.</p>';
  return panel({
    title: 'Master queue',
    id: 'adm-master',
    aside: `<span class="adm-dim adm-small">${master.length} song${master.length === 1 ? '' : 's'}</span>`,
    children: body,
  });
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
}): string {
  const loadingHtml = blocked
    ? `<p class="adm-add-loading adm-small" role="status"><span class="adm-spinner" aria-hidden="true"></span>Adding to ${target === 'master' ? 'master' : 'requests'}…</p>`
    : '';
  const errorHtml =
    lastAdd?.status === 'failed' && lastAdd.error
      ? `<p class="adm-bad-text adm-small" role="alert" data-testid="add-error">${escapeHtml(explainError(lastAdd.error, lastAdd.type).message)}</p>`
      : '';
  return `${loadingHtml}${errorHtml}`;
}

export function AddBar({
  lastAdd,
  nightOpen,
  children = '',
  url = '',
  submitting = null,
}: {
  actions?: Actions;
  lastAdd: Intent | null;
  nightOpen: boolean;
  children?: string;
  url?: string;
  submitting?: 'master' | 'request' | null;
}): string {
  const pending = lastAdd?.status === 'pending';
  const blocked = pending || submitting !== null;
  const target = pending ? (lastAdd.type === 'master.add' ? 'master' : 'request') : submitting;
  const value = url.trim();
  const inputHtml = renderInput({
    attrs: {
      id: 'adm-add-url',
      type: 'url',
      inputmode: 'url',
      value: url,
      disabled: blocked,
    },
  });
  const masterBtn = renderButton({
    type: 'submit',
    variant: 'solid',
    disabled: !value || blocked,
    attrs: { 'data-adm-add-master': 'true' },
    children: 'Add to master',
  });
  const requestBtn = tip(
    nightOpen ? undefined : 'Start the night first',
    renderButton({
      variant: 'outline',
      disabled: !value || !nightOpen || blocked,
      attrs: { 'data-adm-add-request': 'true' },
      children: 'Add to requests',
    }),
  );
  const statusHtml = AddBarStatus({ lastAdd, blocked, target });
  const field = renderField({
    label: 'YouTube, Spotify, or Apple Music track link',
    forId: 'adm-add-url',
    children: `<div class="adm-add-row">${inputHtml}${masterBtn}${requestBtn}</div>${statusHtml}`,
  });
  const card = renderCard({
    className: 'adm-card',
    children: `<form class="adm-add" aria-busy="${blocked ? 'true' : 'false'}">${field}</form>${children}`,
  });
  return `<section class="adm-section" aria-labelledby="adm-queue"><h2 id="adm-queue" class="adm-headline adm-section-title">Queue</h2>${card}</section>`;
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
}): string {
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

  const itemsHtml = visible
    .map((intent) => {
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
      const iso = d.toISOString();
      const titleStr = d.toLocaleString([], { timeZone: 'America/Indiana/Indianapolis' });
      const timeStr = d.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'America/Indiana/Indianapolis',
      });
      const errSpan =
        intent.status === 'failed' && explained
          ? `<span class="adm-small ${explained.tone === 'transient' ? 'adm-warning' : 'adm-bad-text'}" role="alert">${escapeHtml(explained.message)}</span>`
          : '';
      const replaySpan =
        intent.status === 'ok' && intent.replayed
          ? '<span class="adm-dim adm-small">Already applied earlier.</span>'
          : '';
      const retryBtn =
        intent.status === 'failed' && intent.error?.retryable
          ? renderButton({
              variant: 'ghost',
              attrs: { 'data-adm-retry': intent.id },
              children: 'Retry',
            })
          : '';
      return `<li class="adm-row" data-status="${escapeHtml(intent.status)}" data-intent="${escapeHtml(intent.type)}"><time class="adm-action-time adm-dim" dateTime="${escapeHtml(iso)}" title="${escapeHtml(titleStr)}">${escapeHtml(timeStr)}</time><div class="adm-row-main"><span>${escapeHtml(intent.label)}</span>${errSpan}${replaySpan}</div>${tag(tone, label)}${retryBtn}</li>`;
    })
    .join('');

  const empty = !visible.length ? '<p class="adm-empty">No actions yet.</p>' : '';
  const body = `<div class="adm-activity">${empty}<ul class="adm-list" aria-label="Action log">${itemsHtml}</ul></div>`;
  const card = renderCard({ className: 'adm-card', children: body });
  const hiddenAttr = hidden ? ' hidden=""' : '';
  return `<section id="adm-activity" class="adm-section" aria-labelledby="adm-activity-title"${hiddenAttr}><h2 id="adm-activity-title" class="adm-headline adm-section-title">Action log</h2>${card}</section>`;
}
