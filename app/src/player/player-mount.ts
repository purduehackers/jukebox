import type { Snapshot } from '../../../src/contract/types.ts';
import { PlayerController, type PlayerState } from './controller.ts';

export interface PlayerMountOptions {
  onSnapshot?: (snapshot: Snapshot) => void;
  onState?: (state: PlayerState) => void;
  onError?: (error: string | null) => void;
}

/** One connection drives both the native player and display presentation. */
export function mountPlayer(container: HTMLElement, options: PlayerMountOptions = {}): () => void {
  const root = document.createElement('section');
  root.className = 'display-player';
  root.setAttribute('aria-label', 'Display sound');
  root.dataset.testid = 'player';
  root.dataset.status = 'paused';
  root.dataset.generation = '';
  root.dataset.loadId = '';
  root.dataset.epoch = '0';

  const audio = document.createElement('audio');
  audio.id = 'jukebox-audio';
  audio.preload = 'auto';

  const activationNotice = document.createElement('p');
  activationNotice.className = 'display-player-notice';
  activationNotice.setAttribute('role', 'status');
  activationNotice.textContent =
    'Firefox blocked autoplay. Set this site’s Autoplay permission to “Allow Audio and Video”.';
  activationNotice.hidden = true;

  const errorNotice = document.createElement('p');
  errorNotice.className = 'display-player-notice';
  errorNotice.setAttribute('role', 'status');
  errorNotice.hidden = true;

  root.append(audio, activationNotice, errorNotice);
  container.append(root);

  const syncDom = (state: PlayerState) => {
    root.dataset.status = state.status;
    root.dataset.generation = state.generation !== null ? String(state.generation) : '';
    root.dataset.loadId = state.loadId !== null ? String(state.loadId) : '';
    root.dataset.epoch = String(state.epoch ?? 0);

    activationNotice.hidden = state.status !== 'needs_activation';
    if (state.connection === 'error' && state.message) {
      errorNotice.textContent = state.message;
      errorNotice.hidden = false;
    } else {
      errorNotice.textContent = '';
      errorNotice.hidden = true;
    }
  };

  const controller = new PlayerController(
    audio,
    (next) => {
      syncDom(next);
      options.onState?.(next);
    },
    (snapshot) => {
      options.onSnapshot?.(snapshot);
    },
    (error) => {
      options.onError?.(error);
    },
  );

  const restore = (event: PageTransitionEvent) => {
    if (event.persisted) window.location.reload();
  };
  window.addEventListener('pageshow', restore);

  return () => {
    window.removeEventListener('pageshow', restore);
    controller.dispose();
    root.remove();
  };
}
