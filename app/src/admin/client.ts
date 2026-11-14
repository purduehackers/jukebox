// Admin browser mount: drives createLiveAdmin + createAdminControls and reconciles DOM
// slots in place so inputs, range sliders, menus, and buttons never drop focus or capture.
import type { QueueMode, Snapshot } from '../../../src/contract/types.ts';
import {
  escapeHtml,
  renderBadge,
  renderButton,
  renderCard,
  renderDitherButton,
  renderField,
  renderInput,
} from '../components/ph/html.ts';
import {
  PLAYER_LABEL,
  describeTurn,
  estimatePosition,
  formatClock,
  moveAnchor,
  optimisticIntent,
  playerState,
  waitingRequests,
} from './derive.ts';
import type { PlayerState } from './derive.ts';
import { createAdminControls, createLiveAdmin, getServerNow } from './state.ts';
import {
  AccessGateCard,
  ActivityPanel,
  AddBarStatus,
  AlertsBand,
  BanListItems,
  ConfirmButton,
  DisplayWait,
  HeaderMeta,
  MasterQueuePanel,
  NightPanel,
  RequestQueuePanel,
  TurnPanel,
  type Actions,
} from './views.ts';

const time = (sec: number | null) => (sec === null ? '–:––' : formatClock(sec * 1000));

const STATE_TONE: Record<PlayerState, 'ok' | 'warn' | 'bad' | 'info' | 'dim'> = {
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

function tipHtml(title: string | undefined, child: string): string {
  return title ? `<span class="adm-tip" title="${escapeHtml(title)}">${child}</span>` : child;
}

const MODES: { mode: QueueMode; label: string; help: string }[] = [
  { mode: 'auto', label: 'Auto', help: 'Master music, with one request every interval.' },
  { mode: 'master', label: 'Master only', help: 'Request turns are off. Requests wait in the queue.' },
  { mode: 'requests', label: 'Requests only', help: 'Only requests play, one after another. Silent when none are ready.' },
];

export function mountAdminPage(root: HTMLElement): () => void {
  const pageEl = document.getElementById('admin-page');

  let localNow = Date.now();
  let showActivity = false;
  let pendingVolume: number | null = null;
  let draggingSeek: number | null = null;
  let addUrl = '';
  let addSubmitting: 'master' | 'request' | null = null;
  let addInFlight = false;
  let banOpen = false;
  let banUsername = '';
  let qcConfirming = false;
  let qcDraft: string | null = null;
  let lastServerMinutes: number | null = null;
  let armedConfirm: { id: string; context: number | undefined } | null = null;

  // 15-second DisplayWait delay timer keyed on playback.desiredEpoch while waiting.
  let waitEpoch: number | null = null;
  let waitActive = false;
  let displayDelayed = false;
  let waitTimer: number | undefined;

  let renderScheduled = false;
  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      render();
    });
  };

  const live = createLiveAdmin(scheduleRender);
  const controls = createAdminControls(live, scheduleRender);
  const { runner, volume } = controls;
  volume.onPending = (next) => {
    pendingVolume = next;
    scheduleRender();
  };

  const actions: Actions = {
    play: () => runner.run('Play', 'playback.play', {}),
    pause: () => runner.run('Pause', 'playback.pause', {}),
    skip: (entryId) => runner.run('Skip', 'playback.skip', { entryId }),
    replay: (entryId) => runner.run('Restart song', 'playback.seek', { entryId, positionSec: 0 }),
    seek: (entryId, positionSec) =>
      runner.run(
        `Seek to ${Math.floor(positionSec / 60)}:${String(Math.floor(positionSec % 60)).padStart(2, '0')}`,
        'playback.seek',
        { entryId, positionSec },
      ),
    setVolume: (v) => volume.set(v),
    beginVolume: () => volume.begin(),
    commitVolume: () => volume.flush(),
    openNight: () => runner.run('Start night', 'night.open', {}),
    closeNight: (expectedRevision) =>
      runner.run('End night', 'night.close', {}, { expectedRevision }),
    addMaster: (url) => runner.run(`Add to master: ${url}`, 'master.add', { url }),
    addRequest: (url) => runner.run(`Add to requests: ${url}`, 'request.submit', { url }),
    removeMaster: (entryId, title) =>
      runner.run(`Remove “${title}” from master`, 'master.remove', { entryId }),
    moveMaster: (entryId, afterEntryId, title) =>
      runner.run(`Move “${title}”`, 'master.move', { entryId, afterEntryId }),
    setMode: (mode) =>
      runner.run(
        `Play from: ${{ auto: 'Auto', master: 'Master only', requests: 'Requests only' }[mode]}`,
        'queue.mode',
        { mode },
      ),
    setInterval: (periodMs) =>
      runner.run(
        periodMs === null ? 'Use the default request interval' : `Request every ${periodMs / 60_000} min`,
        'queue.interval',
        { periodMs },
      ),
    playNow: (entryId, title) => runner.run(`Play “${title}” now`, 'request.playNow', { entryId }),
    removeRequest: (entryId, title) =>
      runner.run(`Remove request “${title}”`, 'request.remove', { entryId }),
    moveRequest: (entryId, afterEntryId, title) =>
      runner.run(`Move request “${title}”`, 'request.move', { entryId, afterEntryId }),
    banUsername: (username) => runner.run(`Ban PH ID username ${username}`, 'requester.ban', { username }),
    unbanUsername: (username) =>
      runner.run(`Unban PH ID username ${username}`, 'requester.unban', { username }),
    retry: (id) => void runner.retry(id),
  };

  let shellMode: 'gate' | 'loading' | 'console' | null = null;
  let gateHtmlCache = '';

  // Console slot references and memo caches
  let nightSlot: HTMLElement | null = null;
  let banSlot: HTMLElement | null = null;
  let banToggleBtn: HTMLButtonElement | null = null;
  let banSubmenuHost: HTMLElement | null = null;
  let banInput: HTMLInputElement | null = null;
  let banSubmitBtn: HTMLButtonElement | null = null;
  let banListEl: HTMLElement | null = null;
  let activityToggleBtn: HTMLButtonElement | null = null;
  let headerMetaSlot: HTMLElement | null = null;
  let alertsSlot: HTMLElement | null = null;
  let trackSlot: HTMLElement | null = null;
  let seekInput: HTMLInputElement | null = null;
  let posSpan: HTMLElement | null = null;
  let durSpan: HTMLElement | null = null;
  let replayBtn: HTMLButtonElement | null = null;
  let backBtn: HTMLButtonElement | null = null;
  let playPauseSlot: HTMLElement | null = null;
  let fwdBtn: HTMLButtonElement | null = null;
  let skipSlot: HTMLElement | null = null;
  let volInput: HTMLInputElement | null = null;
  let volSpan: HTMLElement | null = null;
  let statusDot: HTMLElement | null = null;
  let statusRow: HTMLElement | null = null;
  let playerStateSpan: HTMLElement | null = null;
  let confirmSpan: HTMLElement | null = null;
  let waitWrap: HTMLElement | null = null;
  let statusHintWrap: HTMLElement | null = null;
  let turnSlot: HTMLElement | null = null;
  let addForm: HTMLFormElement | null = null;
  let addUrlInput: HTMLInputElement | null = null;
  let addMasterBtn: HTMLButtonElement | null = null;
  let addReqWrap: HTMLElement | null = null;
  let addReqBtn: HTMLButtonElement | null = null;
  let addStatusSlot: HTMLElement | null = null;
  let qcModesSlot: HTMLElement | null = null;
  let intervalInput: HTMLInputElement | null = null;
  let intervalSetBtn: HTMLButtonElement | null = null;
  let qcFeedbackSlot: HTMLElement | null = null;
  let masterSlot: HTMLElement | null = null;
  let requestsSlot: HTMLElement | null = null;
  let activitySlot: HTMLElement | null = null;

  let caches: Record<string, string> = {};
  const setHtml = (key: string, el: HTMLElement | null, html: string) => {
    if (!el || caches[key] === html) return;
    caches[key] = html;
    el.innerHTML = html;
  };

  let banListenersActive = false;
  const onBanDocKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && banOpen) {
      banOpen = false;
      render();
      banToggleBtn?.focus();
    }
  };
  const onBanDocPointer = (event: PointerEvent) => {
    if (banOpen && banSlot && !banSlot.contains(event.target as Node)) {
      banOpen = false;
      render();
    }
  };
  const syncBanListeners = () => {
    if (banOpen && !banListenersActive) {
      banListenersActive = true;
      document.addEventListener('keydown', onBanDocKey);
      document.addEventListener('pointerdown', onBanDocPointer);
    } else if (!banOpen && banListenersActive) {
      banListenersActive = false;
      document.removeEventListener('keydown', onBanDocKey);
      document.removeEventListener('pointerdown', onBanDocPointer);
    }
  };

  const resetWaitTimer = (waiting: boolean, desiredEpoch: number | null) => {
    if (waiting !== waitActive || desiredEpoch !== waitEpoch) {
      if (waitTimer !== undefined) {
        window.clearTimeout(waitTimer);
        waitTimer = undefined;
      }
      waitActive = waiting;
      waitEpoch = desiredEpoch;
      displayDelayed = false;
      if (waiting) {
        waitTimer = window.setTimeout(() => {
          displayDelayed = true;
          render();
        }, 15_000);
      }
    }
  };

  const submitAdd = (next: 'master' | 'request') => {
    const value = addUrl.trim();
    const intents = controls.intents;
    const adds = intents.filter((i) => i.type === 'master.add' || i.type === 'request.submit');
    const lastAdd = adds.find((i) => i.status === 'pending') ?? adds[0] ?? null;
    const blocked = lastAdd?.status === 'pending' || addSubmitting !== null;
    if (!value || blocked || addInFlight) return;
    addInFlight = true;
    addSubmitting = next;
    render();
    void (next === 'master' ? actions.addMaster(value) : actions.addRequest(value))
      .then((intent) => {
        if (intent.status === 'ok') {
          addUrl = '';
          if (addUrlInput) addUrlInput.value = '';
        }
      })
      .finally(() => {
        addInFlight = false;
        addSubmitting = null;
        render();
      });
  };

  const executeConfirm = (id: string, context: number | undefined, snapshot: Snapshot) => {
    if (id === 'night-close') {
      void actions.closeNight(context ?? snapshot.revision);
      return;
    }
    if (id === 'skip-now' && snapshot.nowPlaying) {
      void actions.skip(snapshot.nowPlaying.entryId);
      return;
    }
    if (id.startsWith('master-remove:')) {
      const entryId = id.slice('master-remove:'.length);
      const item = (snapshot.master ?? []).find((m) => m.id === entryId);
      if (item) void actions.removeMaster(entryId, item.title);
      return;
    }
    if (id.startsWith('request-playNow:')) {
      const entryId = id.slice('request-playNow:'.length);
      const item = waitingRequests(snapshot).find((r) => r.id === entryId);
      if (item) void actions.playNow(entryId, item.title);
      return;
    }
    if (id.startsWith('request-remove:')) {
      const entryId = id.slice('request-remove:'.length);
      const item = snapshot.requests.find((r) => r.id === entryId);
      if (item) void actions.removeRequest(entryId, item.title);
    }
  };

  const buildConsoleSkeleton = () => {
    shellMode = 'console';
    caches = {};
    pageEl?.removeAttribute('aria-busy');

    const toggleHtml = renderButton({
      variant: 'outline',
      attrs: { 'aria-expanded': String(showActivity), 'aria-controls': 'adm-activity', 'data-adm-activity-toggle': 'true' },
      children: showActivity ? 'Hide activity log' : 'Show activity log',
    });
    const banBtnHtml = renderButton({
      variant: 'outline',
      attrs: {
        'aria-expanded': 'false',
        'aria-controls': 'adm-ban-submenu',
        'aria-haspopup': 'dialog',
        'data-adm-ban-toggle': 'true',
      },
      children: 'Ban…',
    });

    const replayBtnHtml = renderButton({
      variant: 'outline',
      className: 'adm-icon',
      icon: 'refresh',
      disabled: true,
      attrs: { 'aria-label': 'Restart song', title: 'Restart song', 'data-adm-replay-btn': 'true' },
      children: '',
    });
    const backBtnHtml = renderButton({
      variant: 'outline',
      className: 'adm-icon',
      disabled: true,
      attrs: { 'aria-label': 'Back 15 seconds', title: 'Back 15 s', 'data-adm-seek-back': 'true' },
      children: '−15',
    });
    const fwdBtnHtml = renderButton({
      variant: 'outline',
      className: 'adm-icon',
      disabled: true,
      attrs: { 'aria-label': 'Forward 15 seconds', title: 'Forward 15 s', 'data-adm-seek-fwd': 'true' },
      children: '+15',
    });

    const addInputHtml = renderInput({
      attrs: { id: 'adm-add-url', type: 'url', inputmode: 'url', value: addUrl },
    });
    const addMasterHtml = renderButton({
      type: 'submit',
      variant: 'solid',
      disabled: true,
      attrs: { 'data-adm-add-master': 'true' },
      children: 'Add to master',
    });
    const addReqHtml = renderButton({
      variant: 'outline',
      disabled: true,
      attrs: { 'data-adm-add-request': 'true' },
      children: 'Add to requests',
    });
    const addField = renderField({
      label: 'YouTube, Spotify, or Apple Music track link',
      forId: 'adm-add-url',
      children: `<div class="adm-add-row">${addInputHtml}${addMasterHtml}<span class="adm-tip" data-adm-req-tip>${addReqHtml}</span></div><div data-slot="add-status"></div>`,
    });

    const intervalField = renderField({
      label: 'Request every',
      forId: 'adm-interval',
      children: `<div class="adm-interval-row">${renderInput({
        attrs: { id: 'adm-interval', type: 'number', inputmode: 'numeric', step: 1, value: '' },
      })}<span aria-hidden="true">min</span>${renderButton({
        type: 'submit',
        variant: 'outline',
        disabled: true,
        attrs: { 'data-adm-interval-set': 'true' },
        children: 'Set',
      })}</div>`,
    });

    const nowCardInner = `
      <div class="adm-track" data-slot="track"></div>
      <div class="adm-progress">
        <input id="adm-seek" type="range" aria-label="Seek" min="0" max="1" step="1" value="0" disabled />
        <div class="adm-times"><span data-testid="position">–:––</span><span data-adm-duration>–:––</span></div>
      </div>
      <div class="adm-transport">
        ${replayBtnHtml}${backBtnHtml}<span style="display:contents" data-slot="play-pause"></span>${fwdBtnHtml}<span style="display:contents" data-slot="skip-confirm"></span>
        <label class="adm-volume" for="adm-volume">
          <span aria-hidden="true">Vol</span>
          <input id="adm-volume" type="range" aria-label="Volume" min="0" max="100" step="1" value="100" />
          <span data-testid="volume">100%</span>
        </label>
      </div>
      <div class="adm-status adm-dim" data-slot="player-status">
        <span class="adm-dot" aria-hidden="true"></span>
        <span data-testid="player-state"></span>
        <span data-testid="confirmation" data-confirmation="none" hidden></span>
        <span data-slot="wait-wrap">${DisplayWait({ waiting: false, delayed: false })}</span>
        <span style="display:contents" data-slot="status-hint"></span>
      </div>
      <div style="display:contents" data-slot="turn"></div>
    `;

    const queueCardInner = `
      <form class="adm-add" aria-busy="false" data-slot="add-form">${addField}</form>
      <div class="adm-qc" id="adm-queue-control">
        <div class="adm-qc-row">
          <div class="adm-seg" role="radiogroup" aria-label="Play from" data-slot="qc-modes"></div>
          <form class="adm-interval" data-adm-interval-form>${intervalField}</form>
        </div>
        <div style="display:contents" data-slot="qc-feedback"></div>
      </div>
    `;

    root.innerHTML = `
      <header class="adm-header">
        <h1 class="adm-headline adm-h1">Jukebox</h1>
        <div style="display:contents" data-slot="night"></div>
        <div class="adm-ban-menu" data-slot="ban">${banBtnHtml}<div style="display:contents" data-slot="ban-submenu"></div></div>
        <span style="display:contents" data-slot="activity-toggle">${toggleHtml}</span>
        <div class="adm-header-meta" data-slot="header-meta"></div>
      </header>
      <div style="display:contents" data-slot="alerts"></div>
      <section class="adm-section" aria-labelledby="adm-now">
        <h2 id="adm-now" class="adm-headline adm-section-title">Now playing</h2>
        ${renderCard({ className: 'adm-card adm-player', children: nowCardInner })}
      </section>
      <section class="adm-section" aria-labelledby="adm-queue">
        <h2 id="adm-queue" class="adm-headline adm-section-title">Queue</h2>
        ${renderCard({ className: 'adm-card', children: queueCardInner })}
      </section>
      <div class="adm-queues">
        <div style="display:contents" data-slot="master"></div>
        <div style="display:contents" data-slot="requests"></div>
      </div>
      <div style="display:contents" data-slot="activity"></div>
      <footer class="adm-credits">
        Icons: <a href="https://github.com/hackernoon/pixel-icon-library" target="_blank" rel="noreferrer">HackerNoon Pixel Icon Library</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>
      </footer>
    `;

    nightSlot = root.querySelector('[data-slot="night"]');
    banSlot = root.querySelector('[data-slot="ban"]');
    banToggleBtn = root.querySelector('[data-adm-ban-toggle]');
    banSubmenuHost = root.querySelector('[data-slot="ban-submenu"]');
    activityToggleBtn = root.querySelector('[data-adm-activity-toggle]');
    headerMetaSlot = root.querySelector('[data-slot="header-meta"]');
    alertsSlot = root.querySelector('[data-slot="alerts"]');
    trackSlot = root.querySelector('[data-slot="track"]');
    seekInput = root.querySelector('#adm-seek');
    posSpan = root.querySelector('[data-testid="position"]');
    durSpan = root.querySelector('[data-adm-duration]');
    replayBtn = root.querySelector('[data-adm-replay-btn]');
    backBtn = root.querySelector('[data-adm-seek-back]');
    playPauseSlot = root.querySelector('[data-slot="play-pause"]');
    fwdBtn = root.querySelector('[data-adm-seek-fwd]');
    skipSlot = root.querySelector('[data-slot="skip-confirm"]');
    volInput = root.querySelector('#adm-volume');
    volSpan = root.querySelector('[data-testid="volume"]');
    statusRow = root.querySelector('[data-slot="player-status"]');
    statusDot = statusRow?.querySelector('.adm-dot') ?? null;
    playerStateSpan = root.querySelector('[data-testid="player-state"]');
    confirmSpan = root.querySelector('[data-testid="confirmation"]');
    waitWrap = root.querySelector('[data-slot="wait-wrap"]');
    statusHintWrap = root.querySelector('[data-slot="status-hint"]');
    turnSlot = root.querySelector('[data-slot="turn"]');
    addForm = root.querySelector('[data-slot="add-form"]');
    addUrlInput = root.querySelector('#adm-add-url');
    addMasterBtn = root.querySelector('[data-adm-add-master]');
    addReqWrap = root.querySelector('[data-adm-req-tip]');
    addReqBtn = root.querySelector('[data-adm-add-request]');
    addStatusSlot = root.querySelector('[data-slot="add-status"]');
    qcModesSlot = root.querySelector('[data-slot="qc-modes"]');
    intervalInput = root.querySelector('#adm-interval');
    intervalSetBtn = root.querySelector('[data-adm-interval-set]');
    qcFeedbackSlot = root.querySelector('[data-slot="qc-feedback"]');
    masterSlot = root.querySelector('[data-slot="master"]');
    requestsSlot = root.querySelector('[data-slot="requests"]');
    activitySlot = root.querySelector('[data-slot="activity"]');

    banToggleBtn?.addEventListener('click', () => {
      banOpen = !banOpen;
      render();
    });

    activityToggleBtn?.addEventListener('click', () => {
      showActivity = !showActivity;
      if (activityToggleBtn) {
        activityToggleBtn.setAttribute('aria-expanded', String(showActivity));
        activityToggleBtn.textContent = showActivity ? 'Hide activity log' : 'Show activity log';
      }
      render();
    });

    seekInput?.addEventListener('input', () => {
      draggingSeek = Number(seekInput!.value);
      render();
    });
    const commitSeek = () => {
      const snap = live.snapshot;
      if (snap?.nowPlaying && draggingSeek !== null) {
        const pos = draggingSeek;
        draggingSeek = null;
        void actions.seek(snap.nowPlaying.entryId, pos);
        render();
      }
    };
    seekInput?.addEventListener('pointerup', commitSeek);
    seekInput?.addEventListener('keyup', commitSeek);
    seekInput?.addEventListener('blur', commitSeek);

    volInput?.addEventListener('pointerdown', (e) => {
      volInput?.setPointerCapture(e.pointerId);
      actions.beginVolume();
    });
    volInput?.addEventListener('input', () => {
      actions.setVolume(Number(volInput!.value) / 100);
    });
    volInput?.addEventListener('pointerup', () => actions.commitVolume());
    volInput?.addEventListener('pointercancel', () => actions.commitVolume());
    volInput?.addEventListener('blur', () => actions.commitVolume());

    replayBtn?.addEventListener('click', () => {
      const entryId = live.snapshot?.nowPlaying?.entryId;
      if (entryId) void actions.replay(entryId);
    });
    const relSeek = (delta: number) => {
      const snap = live.snapshot;
      if (!snap?.nowPlaying) return;
      const serverNow = getServerNow(live, localNow);
      const pos = estimatePosition(snap, serverNow);
      const seekIntent = optimisticIntent(snap, controls.intents, ['playback.seek']);
      const seek = seekIntent?.payload as { entryId: string; positionSec: number } | undefined;
      const localPosition = seek?.entryId === snap.nowPlaying.entryId ? seek?.positionSec : undefined;
      const base = draggingSeek ?? localPosition ?? pos.positionSec ?? 0;
      void actions.seek(snap.nowPlaying.entryId, Math.max(0, base + delta));
    };
    backBtn?.addEventListener('click', () => relSeek(-15));
    fwdBtn?.addEventListener('click', () => relSeek(15));

    addForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      submitAdd('master');
    });
    addUrlInput?.addEventListener('input', () => {
      addUrl = addUrlInput!.value;
      render();
    });
    addReqBtn?.addEventListener('click', () => submitAdd('request'));

    const intervalForm = root.querySelector<HTMLFormElement>('[data-adm-interval-form]');
    intervalInput?.addEventListener('input', () => {
      qcDraft = intervalInput!.value;
      render();
    });
    intervalForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const snap = live.snapshot;
      if (!snap || qcDraft === null) return;
      const minM = Math.ceil(snap.schedule.periodMinMs / 60_000);
      const maxM = Math.floor(snap.schedule.periodMaxMs / 60_000);
      const minutes = Number(qcDraft);
      if (qcDraft.trim() !== '' && Number.isInteger(minutes) && minutes >= minM && minutes <= maxM) {
        void actions.setInterval(minutes * 60_000);
      }
    });
  };

  const onRootClick = (event: Event) => {
    const snap = live.snapshot;
    if (!snap) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const armBtn = target.closest<HTMLElement>('[data-confirm-arm]');
    if (armBtn?.dataset.confirmArm) {
      const ctxRaw = armBtn.dataset.confirmContext;
      const ctx = ctxRaw !== undefined && ctxRaw !== '' ? Number(ctxRaw) : undefined;
      armedConfirm = { id: armBtn.dataset.confirmArm, context: ctx };
      render();
      return;
    }
    const cancelBtn = target.closest<HTMLElement>('[data-confirm-cancel]');
    if (cancelBtn) {
      armedConfirm = null;
      render();
      return;
    }
    const execBtn = target.closest<HTMLElement>('[data-confirm-exec]');
    if (execBtn?.dataset.confirmExec) {
      const id = execBtn.dataset.confirmExec;
      const ctx = armedConfirm?.id === id ? armedConfirm.context : undefined;
      armedConfirm = null;
      render();
      executeConfirm(id, ctx, snap);
      return;
    }

    if (target.closest('[data-adm-sign-out]')) {
      void (async () => {
        await fetch('/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        live.recheck();
      })();
      return;
    }
    if (target.closest('[data-adm-ack-external]')) {
      live.ackExternal();
      return;
    }
    if (target.closest('[data-adm-night-open]')) {
      void actions.openNight();
      return;
    }
    if (target.closest('[data-adm-play]')) {
      void actions.play();
      return;
    }
    if (target.closest('[data-adm-pause]')) {
      void actions.pause();
      return;
    }
    const unbanBtn = target.closest<HTMLElement>('[data-adm-unban]');
    if (unbanBtn?.dataset.admUnban) {
      void actions.unbanUsername(unbanBtn.dataset.admUnban);
      return;
    }

    const modeBtn = target.closest<HTMLElement>('[data-mode]');
    if (modeBtn?.dataset.mode) {
      const next = modeBtn.dataset.mode as QueueMode;
      const pendingMode = optimisticIntent(snap, controls.intents, ['queue.mode'])?.payload as
        | { mode: QueueMode }
        | undefined;
      const curMode = pendingMode?.mode ?? snap.schedule.mode;
      const current = snap.schedule.phase === 'master' ? snap.nowPlaying : null;
      if (next === 'requests' && current) {
        qcConfirming = true;
        render();
        return;
      }
      qcConfirming = false;
      if (next !== curMode) {
        void actions.setMode(next);
      } else {
        render();
      }
      return;
    }
    if (target.closest('[data-adm-confirm-requests-only]')) {
      qcConfirming = false;
      render();
      void actions.setMode('requests');
      return;
    }
    if (target.closest('[data-adm-cancel-requests-only]')) {
      qcConfirming = false;
      render();
      return;
    }

    const moveBtn = target.closest<HTMLElement>('[data-adm-move-queue]');
    if (moveBtn?.dataset.admMoveQueue && moveBtn.dataset.admMoveId && moveBtn.dataset.admMoveDir) {
      const queue = moveBtn.dataset.admMoveQueue as 'master' | 'request';
      const entryId = moveBtn.dataset.admMoveId;
      const dir = moveBtn.dataset.admMoveDir as 'up' | 'down';
      if (queue === 'master') {
        const list = snap.master ?? [];
        const index = list.findIndex((m) => m.id === entryId);
        const ids = list.map((m) => m.id);
        const anchor = index >= 0 ? moveAnchor(ids, index, dir) : null;
        if (anchor && list[index]) void actions.moveMaster(entryId, anchor.afterEntryId, list[index]!.title);
      } else {
        const list = waitingRequests(snap);
        const index = list.findIndex((r) => r.id === entryId);
        const ids = list.map((r) => r.id);
        const anchor = index >= 0 ? moveAnchor(ids, index, dir) : null;
        if (anchor && list[index]) void actions.moveRequest(entryId, anchor.afterEntryId, list[index]!.title);
      }
      return;
    }

    const retryBtn = target.closest<HTMLElement>('[data-adm-retry]');
    if (retryBtn?.dataset.admRetry) {
      actions.retry(retryBtn.dataset.admRetry);
    }
  };
  root.addEventListener('click', onRootClick);

  const render = () => {
    const access = live.access;
    const snap = live.snapshot;

    if (access.state !== 'admin') {
      syncBanListeners();
      resetWaitTimer(false, null);
      shellMode = 'gate';
      const gate = AccessGateCard(access);
      if (gate.busy) pageEl?.setAttribute('aria-busy', 'true');
      else pageEl?.removeAttribute('aria-busy');
      if (gateHtmlCache !== gate.html) {
        gateHtmlCache = gate.html;
        root.innerHTML = gate.html;
      }
      return;
    }

    if (!snap) {
      syncBanListeners();
      resetWaitTimer(false, null);
      shellMode = 'loading';
      pageEl?.setAttribute('aria-busy', 'true');
      const loadingHtml = renderCard({ className: 'adm-card adm-gate', children: '<p>Loading…</p>' });
      if (gateHtmlCache !== loadingHtml) {
        gateHtmlCache = loadingHtml;
        root.innerHTML = loadingHtml;
      }
      return;
    }

    if (shellMode !== 'console') {
      gateHtmlCache = '';
      buildConsoleSkeleton();
    }

    const serverNow = getServerNow(live, localNow);
    const intents = controls.intents;

    // Header slots
    setHtml(
      'night',
      nightSlot,
      NightPanel({ snapshot: snap, armed: armedConfirm?.id === 'night-close' }),
    );
    setHtml('header-meta', headerMetaSlot, HeaderMeta({ name: access.name, link: live.link, linkError: live.linkError }));

    // BanMenu
    if (banToggleBtn) {
      banToggleBtn.setAttribute('aria-expanded', String(banOpen));
    }
    syncBanListeners();
    if (banOpen && banSubmenuHost) {
      if (!banSubmenuHost.querySelector('#adm-ban-submenu')) {
        const field = renderField({
          label: 'PH ID username',
          forId: 'adm-ban-username',
          hint: 'Letters, numbers, dot, underscore or hyphen.',
          children: renderInput({
            attrs: { id: 'adm-ban-username', autocomplete: 'off', maxlength: 40, value: banUsername },
          }),
        });
        const btn = renderButton({
          type: 'submit',
          disabled: !/^[a-zA-Z0-9._-]{1,40}$/.test(banUsername.trim()),
          attrs: { 'data-adm-ban-submit': 'true' },
          children: 'Ban username',
        });
        const card = renderCard({
          className: 'adm-ban-submenu',
          children: `<h2 class="ph-subheadline">Request bans</h2><p class="adm-small">Blocks new submissions by this PH ID username. Existing requests stay in the queue.</p><form class="adm-ban-form" data-adm-ban-form>${field}${btn}</form><ul class="adm-ban-list" aria-label="Banned usernames"></ul>`,
        });
        banSubmenuHost.innerHTML = `<div id="adm-ban-submenu">${card}</div>`;
        banInput = banSubmenuHost.querySelector<HTMLInputElement>('#adm-ban-username');
        banSubmitBtn = banSubmenuHost.querySelector<HTMLButtonElement>('[data-adm-ban-submit]');
        banListEl = banSubmenuHost.querySelector<HTMLElement>('.adm-ban-list');
        const banForm = banSubmenuHost.querySelector<HTMLFormElement>('[data-adm-ban-form]');
        banInput?.addEventListener('input', () => {
          banUsername = banInput!.value;
          if (banSubmitBtn) {
            banSubmitBtn.disabled = !/^[a-zA-Z0-9._-]{1,40}$/.test(banUsername.trim());
          }
        });
        banForm?.addEventListener('submit', (e) => {
          e.preventDefault();
          const v = banUsername.trim();
          if (!/^[a-zA-Z0-9._-]{1,40}$/.test(v)) return;
          void actions.banUsername(v).then((intent) => {
            if (intent.status === 'ok') {
              banUsername = '';
              if (banInput) banInput.value = '';
              if (banSubmitBtn) banSubmitBtn.disabled = true;
            }
          });
        });
        banInput?.focus();
      }
      if (banSubmitBtn) {
        banSubmitBtn.disabled = !/^[a-zA-Z0-9._-]{1,40}$/.test(banUsername.trim());
      }
      setHtml('ban-list', banListEl, BanListItems(snap.bannedUsernames ?? []));
    } else if (!banOpen && banSubmenuHost && banSubmenuHost.childElementCount > 0) {
      banSubmenuHost.replaceChildren();
      banInput = null;
      banSubmitBtn = null;
      banListEl = null;
      delete caches['ban-list'];
    }

    // Alerts
    setHtml(
      'alerts',
      alertsSlot,
      AlertsBand({ snapshot: snap, link: live.link, external: live.externalChange }),
    );

    // Now Playing + Turn
    const now = snap.nowPlaying;
    const state = playerState(snap);
    const { confirmation } = snap.playback;
    const position = estimatePosition(snap, serverNow);
    const transportIntent = optimisticIntent(snap, intents, ['playback.play', 'playback.pause']);
    const seekIntent = optimisticIntent(snap, intents, ['playback.seek']);
    const volumeIntent = optimisticIntent(snap, intents, ['playback.volume']);
    const playing = transportIntent
      ? transportIntent.type === 'playback.play'
      : snap.schedule.intent === 'playing';
    const seek = seekIntent?.payload as { entryId: string; positionSec: number } | undefined;
    const localPosition = seek?.entryId === now?.entryId ? seek?.positionSec : undefined;
    const shownPosition = draggingSeek ?? localPosition ?? position.positionSec ?? 0;
    const vol =
      pendingVolume ??
      (volumeIntent?.payload as { volume: number } | undefined)?.volume ??
      snap.playback.volume;
    const lapsed = confirmation === 'confirmed' && (state === 'offline' || state === 'no_display');
    const hint =
      state === 'needs_activation'
        ? 'Allow autoplay for this site in Firefox’s address bar.'
        : state === 'error'
          ? (snap.playback.observed?.error ?? null)
          : null;
    const tone = state === 'no_display' ? 'warn' : STATE_TONE[state];
    const request = now?.kind === 'request' ? snap.requests.find((r) => r.id === now.entryId) : undefined;
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
      const resumedLine = snap.suspendedMaster
        ? `<p class="adm-dim adm-small">“${escapeHtml(snap.suspendedMaster.title)}” resumes at ${escapeHtml(time(snap.suspendedMaster.positionSec))} after this.</p>`
        : '';
      trackTextHtml = `<p class="adm-headline adm-now-title" data-testid="now-title">${escapeHtml(now.title)}</p><p class="adm-meta">${kindBadge}<span class="adm-dim">${escapeHtml(metaText)}</span></p>${resumedLine}`;
    } else if (snap.schedule.requestsIdle) {
      const reqBadge = renderBadge({ className: 'adm-kind', color: 'yellow', children: 'Requests only' });
      const resumedLine = snap.suspendedMaster
        ? `<p class="adm-dim adm-small">“${escapeHtml(snap.suspendedMaster.title)}” resumes at ${escapeHtml(time(snap.suspendedMaster.positionSec))} when you switch back.</p>`
        : '';
      trackTextHtml = `<p class="adm-headline adm-now-title adm-dim">Waiting for requests.</p><p class="adm-meta">${reqBadge}</p>${resumedLine}`;
    } else {
      trackTextHtml = '<p class="adm-headline adm-now-title adm-dim">Nothing playing. Add songs to the master queue.</p>';
    }
    setHtml(
      'track',
      trackSlot,
      `<div class="${artClass}" aria-hidden="true">${artInner}</div><div class="adm-track-text">${trackTextHtml}</div>`,
    );

    if (seekInput) {
      seekInput.max = String(Math.max(1, Math.floor(position.durationSec ?? 1)));
      seekInput.disabled = !now || position.durationSec === null;
      if (draggingSeek === null) seekInput.value = String(Math.floor(shownPosition));
    }
    if (posSpan) {
      posSpan.textContent = time(position.positionSec === null && draggingSeek === null ? null : shownPosition);
    }
    if (durSpan) durSpan.textContent = time(position.durationSec);
    if (replayBtn) replayBtn.disabled = !now;
    if (backBtn) backBtn.disabled = !canSeek;
    if (fwdBtn) fwdBtn.disabled = !canSeek;

    const playPauseHtml = playing
      ? renderDitherButton({ className: 'adm-play', attrs: { 'data-adm-pause': 'true' }, children: 'Pause' })
      : renderDitherButton({
          className: 'adm-play',
          disabled: snap.night?.status !== 'open',
          attrs: { 'data-adm-play': 'true' },
          children: 'Play',
        });
    setHtml('play-pause', playPauseSlot, playPauseHtml);

    const skipHtml = now
      ? ConfirmButton({
          label: 'Skip…',
          confirmLabel: 'Skip',
          armed: armedConfirm?.id === 'skip-now',
          confirmId: 'skip-now',
          warning:
            now.kind === 'request'
              ? 'Ends this request without giving it back; master music resumes.'
              : 'Jumps to the next master song. The request timer keeps going.',
        })
      : renderButton({ variant: 'outline', disabled: true, children: 'Skip…' });
    setHtml('skip-confirm', skipSlot, skipHtml);

    const volPct = Math.round(vol * 100);
    if (volInput && volInput.value !== String(volPct)) {
      volInput.value = String(volPct);
    }
    if (volSpan) volSpan.textContent = `${volPct}%`;

    const waitingAck = confirmation === 'requested' || confirmation === 'unconfirmed';
    resetWaitTimer(waitingAck, snap.playback.desiredEpoch);
    if (statusRow) statusRow.className = `adm-status adm-${tone}`;
    if (statusDot) void statusDot;
    if (playerStateSpan) playerStateSpan.textContent = PLAYER_LABEL[state];
    if (confirmSpan) confirmSpan.dataset.confirmation = lapsed ? 'lapsed' : confirmation;
    setHtml('wait-wrap', waitWrap, DisplayWait({ waiting: waitingAck, delayed: displayDelayed }));
    setHtml(
      'status-hint',
      statusHintWrap,
      hint ? `<span class="adm-status-hint">${escapeHtml(hint)}</span>` : '',
    );

    const turnHtml = TurnPanel({ snapshot: snap, serverNow });
    if (turnSlot && caches['turn'] !== turnHtml) {
      const existingHeadline = turnSlot.querySelector<HTMLElement>('[data-testid="turn-headline"]');
      const existingTurnEl = turnSlot.querySelector<HTMLElement>('#adm-turn');
      const turnInfo = describeTurn(snap, serverNow);
      if (turnInfo.kind !== 'in_request' && existingTurnEl && existingHeadline) {
        caches['turn'] = turnHtml;
        existingTurnEl.dataset.kind = turnInfo.kind;
        existingHeadline.textContent = turnInfo.headline;
      } else {
        setHtml('turn', turnSlot, turnHtml);
      }
    }

    // AddBar (persistent #adm-add-url)
    const adds = intents.filter((i) => i.type === 'master.add' || i.type === 'request.submit');
    const lastAdd = adds.find((i) => i.status === 'pending') ?? adds[0] ?? null;
    const pendingAdd = lastAdd?.status === 'pending';
    const blocked = pendingAdd || addSubmitting !== null;
    const addTarget = pendingAdd
      ? lastAdd.type === 'master.add'
        ? 'master'
        : 'request'
      : addSubmitting;
    const trimmedUrl = addUrl.trim();
    const nightOpen = snap.night?.status === 'open';
    if (addForm) addForm.setAttribute('aria-busy', String(blocked));
    if (addUrlInput) {
      addUrlInput.disabled = blocked;
      if (document.activeElement !== addUrlInput && addUrlInput.value !== addUrl) {
        addUrlInput.value = addUrl;
      }
    }
    if (addMasterBtn) addMasterBtn.disabled = !trimmedUrl || blocked;
    if (addReqWrap) {
      if (nightOpen) addReqWrap.removeAttribute('title');
      else addReqWrap.setAttribute('title', 'Start the night first');
    }
    if (addReqBtn) addReqBtn.disabled = !trimmedUrl || !nightOpen || blocked;
    setHtml('add-status', addStatusSlot, AddBarStatus({ lastAdd, blocked, target: addTarget }));

    // QueueControls (persistent #adm-interval)
    const { schedule } = snap;
    const pendingMode = optimisticIntent(snap, intents, ['queue.mode'])?.payload as
      | { mode: QueueMode }
      | undefined;
    const mode = pendingMode?.mode ?? schedule.mode;
    const currentMinutes = Math.round(schedule.periodMs / 60_000);
    if (lastServerMinutes !== currentMinutes || qcDraft === null) {
      lastServerMinutes = currentMinutes;
      qcDraft = String(currentMinutes);
    }
    const minMinutes = Math.ceil(schedule.periodMinMs / 60_000);
    const maxMinutes = Math.floor(schedule.periodMaxMs / 60_000);
    const minutes = Number(qcDraft);
    const valid =
      qcDraft.trim() !== '' &&
      Number.isInteger(minutes) &&
      minutes >= minMinutes &&
      minutes <= maxMinutes;
    const elapsedMs =
      mode === 'auto' && schedule.phase === 'master' && schedule.periodStartedAt !== null
        ? serverNow - schedule.periodStartedAt
        : null;
    const readyCount = waitingRequests(snap).filter((r) => r.status === 'ready').length;
    const alreadyElapsed = valid && elapsedMs !== null && elapsedMs >= minutes * 60_000;

    const modesHtml = MODES.map((m) => {
      const unavailable = m.mode === 'requests' && !nightOpen;
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
      return tipHtml(unavailable ? 'Start the night first' : m.help, btn);
    }).join('');
    setHtml('qc-modes', qcModesSlot, modesHtml);

    if (intervalInput) {
      intervalInput.min = String(minMinutes);
      intervalInput.max = String(maxMinutes);
      if (document.activeElement !== intervalInput && intervalInput.value !== qcDraft) {
        intervalInput.value = qcDraft;
      }
      if (qcDraft !== '' && !valid) intervalInput.setAttribute('aria-invalid', 'true');
      else intervalInput.removeAttribute('aria-invalid');
    }
    if (intervalSetBtn) intervalSetBtn.disabled = !valid || minutes === currentMinutes;

    const currentTrack = schedule.phase === 'master' ? snap.nowPlaying : null;
    const interruption = currentTrack
      ? `Interrupts “${currentTrack.title}” now; it resumes where it left off when you leave Requests only.${readyCount ? '' : ' No request is ready, so music stops until one is.'}`
      : '';
    const invalidWarn =
      !valid && qcDraft !== ''
        ? `<p class="adm-warning adm-small" role="alert">Use a whole number from ${minMinutes} to ${maxMinutes} minutes.</p>`
        : '';
    const elapsedWarn = alreadyElapsed
      ? `<p class="adm-warning adm-small" data-testid="interval-warning">${escapeHtml(formatClock(elapsedMs!))} has already passed in this interval, so saving now makes the turn due right away${readyCount ? '' : ' (nothing is ready, so the timer just restarts)'}.</p>`
      : '';
    const confirmBox = qcConfirming
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
    setHtml('qc-feedback', qcFeedbackSlot, `${invalidWarn}${elapsedWarn}${confirmBox}`);

    // Master, Requests, Activity
    setHtml(
      'master',
      masterSlot,
      MasterQueuePanel({ snapshot: snap, armedId: armedConfirm?.id ?? null }),
    );
    setHtml(
      'requests',
      requestsSlot,
      RequestQueuePanel({ snapshot: snap, armedId: armedConfirm?.id ?? null }),
    );
    setHtml(
      'activity',
      activitySlot,
      ActivityPanel({
        intents,
        hidden: !showActivity,
        activity: snap.queueActivity,
        actorName: access.name,
      }),
    );
  };

  render();
  const ticker = window.setInterval(() => {
    localNow = Date.now();
    render();
  }, 1000);

  return () => {
    window.clearInterval(ticker);
    if (waitTimer !== undefined) window.clearTimeout(waitTimer);
    if (banListenersActive) {
      document.removeEventListener('keydown', onBanDocKey);
      document.removeEventListener('pointerdown', onBanDocPointer);
    }
    root.removeEventListener('click', onRootClick);
    controls.dispose();
    live.dispose();
  };
}
