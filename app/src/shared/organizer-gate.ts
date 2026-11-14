import { fetchMe } from './api.ts';

function renderGateNotice(root: HTMLElement, role: string | null, error: boolean) {
  root.replaceChildren();
  const main = document.createElement('main');
  main.className = 'display-idle';
  main.dataset.testid = 'organizer-gate';

  const box = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = 'JUKEBOX';

  const p = document.createElement('p');
  p.textContent = role
    ? 'Organizer sign-in required'
    : error
      ? 'Could not check sign-in. Reconnecting…'
      : 'Checking sign-in…';

  box.append(h1, p);

  if (role) {
    const a = document.createElement('a');
    a.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
    a.textContent = 'Sign in with Purdue Hackers ID';
    box.append(a);
  }

  main.append(box);
  root.append(main);
}

/** Mount no player or display until the server confirms an organizer session. */
export function startOrganizerGate(
  root: HTMLElement,
  mountAuthorized: (container: HTMLElement) => () => void,
  _defaultReturnTo?: string,
): () => void {
  let stopped = false;
  let busy = false;
  let role: string | null = null;
  let error = false;
  let activeCleanup: (() => void) | null = null;

  const unmountAuthorized = () => {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
  };

  renderGateNotice(root, role, error);

  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const me = await fetchMe();
      if (stopped) return;
      role = me.role;
      error = false;
      if (role === 'admin') {
        if (!activeCleanup) {
          root.replaceChildren();
          activeCleanup = mountAuthorized(root);
        }
      } else {
        unmountAuthorized();
        renderGateNotice(root, role, error);
      }
    } catch {
      if (stopped) return;
      error = true;
      if (!activeCleanup) {
        renderGateNotice(root, role, error);
      }
    } finally {
      busy = false;
    }
  };

  void check();
  const timer = window.setInterval(() => {
    void check();
  }, 5000);
  const onFocus = () => {
    void check();
  };
  window.addEventListener('focus', onFocus);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener('focus', onFocus);
    unmountAuthorized();
  };
}
