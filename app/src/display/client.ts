import type { Snapshot } from '../../../src/contract/types.ts';
import { escapeHtml } from '../components/ph/html.ts';
import { mountPlayer, type PlayerMountOptions } from '../player/player-mount.ts';
import type { PlayerState } from '../player/controller.ts';
import { subscribeLightningColors, type LightningColors } from '../shared/lightning-clock.ts';
import { startOrganizerGate } from '../shared/organizer-gate.ts';
import { displaySettings } from '../visual/display-preset.ts';
import { mountSoundbar, type SoundbarHandle } from '../visual/soundbar-mount.ts';
import { displayFixture, fixtureStates, type FixtureState } from './fixtures.ts';
import { displayModel, duration, safeArtwork, type LocalPlayback } from './model.ts';
import { renderRequestQrSection } from './qr.ts';

function isFixtureState(value: string): value is FixtureState {
  return (fixtureStates as readonly string[]).includes(value);
}

function toLocalPlayback(state: PlayerState | null): LocalPlayback | null {
  if (!state) return null;
  return {
    status: state.status,
    positionSec: state.positionSec,
    loadId: state.loadId,
    epoch: state.epoch,
  };
}

function applyBorderColors(el: HTMLElement, colors: LightningColors) {
  el.style.borderImageSource = `linear-gradient(120deg in oklch, ${colors.boltColor}, ${colors.zapColor}, ${colors.sparkColor})`;
  el.style.borderImageSlice = '1';
}

function createDisplayShell(container: HTMLElement) {
  let snapshot: Snapshot | null = null;
  let error: string | null = null;
  let local: LocalPlayback | null = null;
  let clock = { server: Date.now(), receipt: performance.now() };
  let now = Date.now();
  let soundbar: SoundbarHandle | null = null;
  let colors: LightningColors = { boltColor: '#7e3cff', zapColor: '#897309', sparkColor: '#ef4444' };

  const host = document.createElement('div');
  container.append(host);

  let mode: 'idle' | 'live' | null = null;
  let mainEl: HTMLElement | null = null;
  let nowBoxEl: HTMLElement | null = null;
  let artEl: HTMLElement | null = null;
  let currentArtUrl: string | undefined;
  let artFailed = false;
  let kindEl: HTMLElement | null = null;
  let statusEl: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let artistEl: HTMLElement | null = null;
  let elapsedEl: HTMLElement | null = null;
  let progressEl: HTMLProgressElement | null = null;
  let durationEl: HTMLElement | null = null;
  let turnEl: HTMLElement | null = null;
  let warningsHost: HTMLElement | null = null;
  let queueEl: HTMLElement | null = null;

  const unsubColors = subscribeLightningColors((next) => {
    colors = next;
    if (nowBoxEl) applyBorderColors(nowBoxEl, colors);
  });

  const renderArtwork = (safeUrl: string | undefined) => {
    if (!artEl) return;
    if (safeUrl !== currentArtUrl) {
      currentArtUrl = safeUrl;
      artFailed = false;
    }
    if (safeUrl && !artFailed) {
      const existing = artEl.querySelector('img');
      if (existing && existing.getAttribute('src') === safeUrl) return;
      artEl.replaceChildren();
      const img = document.createElement('img');
      img.src = safeUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        artFailed = true;
        renderArtwork(currentArtUrl);
      });
      artEl.append(img);
    } else {
      if (artEl.textContent === 'No artwork' && !artEl.querySelector('img')) return;
      artEl.innerHTML = '<span>No artwork</span>';
    }
  };

  const renderIdle = (stateAttr: 'idle' | 'connecting', text: string) => {
    if (mode !== 'idle') {
      soundbar?.dispose();
      soundbar = null;
      host.innerHTML = `<main class="display-idle" data-testid="display" data-state="${stateAttr}"><div><h1>JUKEBOX</h1><p></p></div></main>`;
      mode = 'idle';
      mainEl = host.querySelector('main');
      nowBoxEl = null;
    } else if (mainEl) {
      mainEl.dataset.state = stateAttr;
    }
    const p = host.querySelector('p');
    if (p) p.textContent = text;
  };

  const ensureLiveDom = () => {
    if (mode === 'live' && mainEl) return;
    host.innerHTML = `
      <main class="jukebox-display" data-testid="display" data-state="paused">
        <div class="display-left">
          <section class="display-visualizer" aria-label="Audio-reactive soundbar"></section>
          <section class="display-now" aria-label="Now playing">
            <div class="display-artwork"><span>No artwork</span></div>
            <div class="display-metadata">
              <div class="display-kicker">
                <span class="display-kind"></span>
                <span class="display-status" role="status"></span>
              </div>
              <h1></h1>
              <p class="display-artist"></p>
              <div class="display-progress">
                <span data-elapsed>–:––</span>
                <progress aria-label="Track progress" value="0" max="1"></progress>
                <span data-duration>–:––</span>
              </div>
            </div>
          </section>
        </div>
        <aside class="display-sidebar" aria-label="Request queue">
          <div class="display-queue-panel">
            <h2 class="display-heading">QUEUE</h2>
            <section class="display-turn"></section>
            <div data-warnings></div>
            <div class="display-queue"></div>
          </div>
          ${renderRequestQrSection()}
        </aside>
      </main>
    `;

    mode = 'live';
    currentArtUrl = undefined;
    artFailed = false;
    mainEl = host.querySelector<HTMLElement>('.jukebox-display');
    const vizEl = host.querySelector<HTMLElement>('.display-visualizer');
    nowBoxEl = host.querySelector<HTMLElement>('.display-now');
    if (nowBoxEl) applyBorderColors(nowBoxEl, colors);
    artEl = host.querySelector<HTMLElement>('.display-artwork');
    kindEl = host.querySelector<HTMLElement>('.display-kind');
    statusEl = host.querySelector<HTMLElement>('.display-status');
    titleEl = host.querySelector<HTMLElement>('.display-metadata h1');
    artistEl = host.querySelector<HTMLElement>('.display-artist');
    elapsedEl = host.querySelector<HTMLElement>('[data-elapsed]');
    progressEl = host.querySelector<HTMLProgressElement>('.display-progress progress');
    durationEl = host.querySelector<HTMLElement>('[data-duration]');
    turnEl = host.querySelector<HTMLElement>('.display-turn');
    warningsHost = host.querySelector<HTMLElement>('[data-warnings]');
    queueEl = host.querySelector<HTMLElement>('.display-queue');

    if (vizEl) {
      soundbar = mountSoundbar(vizEl, { settings: displaySettings, active: false });
    }
  };

  const render = () => {
    if (!snapshot || snapshot.night?.status !== 'open') {
      const idleState = snapshot ? 'idle' : 'connecting';
      const idleMsg = snapshot
        ? 'Night not started'
        : error
          ? 'Connecting to Jukebox…'
          : 'Waiting for the session…';
      renderIdle(idleState, idleMsg);
      return;
    }

    const model = displayModel(snapshot, now, !!error, local);
    const track = snapshot.nowPlaying;
    const requester =
      track?.kind === 'request'
        ? snapshot.requests.find((entry) => entry.id === track.entryId)?.requester
        : undefined;
    const status = model.status.replaceAll('_', ' ');

    ensureLiveDom();

    if (mainEl) mainEl.dataset.state = model.status;
    soundbar?.setActive(local ? local.status === 'playing' : model.playing);
    renderArtwork(safeArtwork(track?.artworkUrl));

    if (kindEl) {
      if (track?.kind) kindEl.dataset.kind = track.kind;
      else delete kindEl.dataset.kind;
      kindEl.textContent = track ? (track.kind === 'request' ? 'Request Queue' : 'Master Queue') : 'JUKEBOX';
    }
    if (statusEl) {
      statusEl.textContent = `${status}${track && !model.confirmed ? ' · awaiting player confirmation' : ''}`;
    }
    if (titleEl) {
      const titleText = track?.title ?? 'Waiting for music';
      titleEl.title = track?.title ?? '';
      titleEl.textContent = titleText;
    }
    if (artistEl) {
      const artistText = track?.artist || (track ? 'Artist unavailable' : 'Organizer controls playback from /admin');
      artistEl.title = track?.artist ?? '';
      artistEl.textContent = artistText;
    }
    if (elapsedEl) elapsedEl.textContent = duration(model.progress);
    if (durationEl) durationEl.textContent = duration(track?.durationSec);
    if (progressEl) {
      progressEl.max = track?.durationSec || 1;
      progressEl.value = model.progress ?? 0;
    }

    if (turnEl) {
      turnEl.setAttribute('aria-label', track?.kind === 'request' ? 'Now playing' : 'Next request');
      turnEl.innerHTML = `${track?.kind !== 'request' ? '<span>NEXT REQUEST</span>' : ''}${requester ? '<span class="display-requested-label">Requested by</span>' : ''}<strong>${escapeHtml(requester ?? model.turn)}</strong>${model.detail ? `<p>${escapeHtml(model.detail)}</p>` : ''}`;
    }

    if (warningsHost) {
      if (error) {
        warningsHost.innerHTML = '<p class="display-warning" role="alert">Connection lost · showing last known state</p>';
      } else if (model.status === 'offline') {
        warningsHost.innerHTML = '<p class="display-warning">Playback device offline</p>';
      } else {
        warningsHost.replaceChildren();
      }
    }

    if (queueEl) {
      const visible = model.requests.slice(0, 4);
      const listHtml = visible
        .map(
          (entry, index) => `<li${entry.status === 'playing' ? ' data-playing="true"' : ''}><span class="display-number">${index + 1}</span><div><strong title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</strong><p title="${escapeHtml(entry.artist ?? '')}">${escapeHtml(entry.artist || 'Artist unavailable')}${entry.status === 'preparing' ? ' · preparing audio' : ''}</p></div><span>${escapeHtml(duration(entry.durationSec))}</span></li>`,
        )
        .join('');
      const emptyHtml =
        model.requests.length === 0
          ? '<p class="display-empty">No requests waiting.<br />Scan below to add yours.</p>'
          : '';
      const moreHtml =
        model.requests.length > 4
          ? `<p class="display-more">+ ${model.requests.length - 4} more requests</p>`
          : '';
      queueEl.innerHTML = `<ol>${listHtml}</ol>${emptyHtml}${moreHtml}`;
    }
  };

  render();
  const timer = window.setInterval(() => {
    now = clock.server + performance.now() - clock.receipt;
    render();
  }, 250);

  return {
    setSnapshot(next: Snapshot) {
      snapshot = next;
      clock = { server: next.serverTime, receipt: performance.now() };
      now = next.serverTime;
      render();
    },
    setPlayerState(next: PlayerState) {
      local = toLocalPlayback(next);
      render();
    },
    setError(next: string | null) {
      error = next;
      render();
    },
    dispose() {
      window.clearInterval(timer);
      unsubColors();
      soundbar?.dispose();
      host.remove();
    },
  };
}

export function mountDisplayPage(root: HTMLElement): () => void {
  const query = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get('displayFixture')
    : null;

  if (import.meta.env.DEV && query !== null) {
    let current: FixtureState = isFixtureState(query) ? query : 'master';
    const shell = createDisplayShell(root);
    const applyFixture = (state: FixtureState) => {
      shell.setError(state === 'disconnected' ? 'Fixture connection failure' : null);
      shell.setSnapshot(displayFixture(state, Date.now()));
    };
    applyFixture(current);

    const wrap = document.createElement('div');
    wrap.className = 'display-fixture-control';
    const label = document.createElement('label');
    label.textContent = 'DEV SNAPSHOT · no playback ';
    const select = document.createElement('select');
    for (const name of fixtureStates) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      opt.selected = name === current;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      if (isFixtureState(select.value)) {
        current = select.value;
        shell.setError(current === 'disconnected' ? 'Fixture connection failure' : null);
        shell.setSnapshot(displayFixture(current, Date.now()));
      }
    });
    label.append(select);
    wrap.append(label);
    root.append(wrap);

    return () => {
      wrap.remove();
      shell.dispose();
    };
  }

  return startOrganizerGate(root, (container) => {
    const shell = createDisplayShell(container);
    const playerHost = document.createElement('div');
    container.append(playerHost);
    const options: PlayerMountOptions = {
      onSnapshot: (snap) => shell.setSnapshot(snap),
      onState: (state) => shell.setPlayerState(state),
      onError: (err) => shell.setError(err),
    };
    const stopPlayer = mountPlayer(playerHost, options);
    return () => {
      stopPlayer();
      playerHost.remove();
      shell.dispose();
    };
  });
}
