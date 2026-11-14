import type { RequestEntryView, Snapshot } from '../../../src/contract/types.ts';
import {
  escapeHtml,
  renderBadge,
  renderButton,
  renderCard,
  renderDitherButton,
  renderField,
  renderInput,
  type BadgeColor,
} from '../components/ph/html.ts';
import { fetchMe, sendCommand, subscribeSnapshots } from '../shared/api.ts';
import { RequestFlow, sessionIntentStore, type FlowState } from './controller.ts';
import {
  STATUS_COPY,
  WAITING,
  describeError,
  formatDuration,
  readDisambiguation,
  type StatusCopy,
  type Tone,
} from './model.ts';

const NOTICE_BORDER: Record<Tone, string> = {
  info: 'border-ph-pink',
  warn: 'border-ph-yellow',
  error: 'border-ph-orange',
};

const STATUS_BADGE: Record<StatusCopy['tone'], BadgeColor> = {
  wait: 'pink',
  live: 'yellow',
  done: 'outline',
  problem: 'orange',
};

function renderNotice(tone: Tone, contentHtml: string, role?: 'alert' | 'status'): string {
  const roleAttr = role ? ` role="${role}"` : '';
  return `<div class="q-notice border bg-card p-3 ${NOTICE_BORDER[tone]}"${roleAttr}>${contentHtml}</div>`;
}

function renderSignIn(open: boolean): string {
  const closedLine = !open
    ? '<p>No night is open right now. You can still sign in and check back later.</p>'
    : '';
  const body = `<h2 class="ph-headline text-3xl">Sign in to request</h2>${closedLine}${renderDitherButton({ href: '/auth/login?returnTo=/queue', children: 'Sign in with Purdue Hackers ID' })}`;
  return renderCard({ children: body });
}

function renderAccountHtml(name: string | null): string {
  const who = name ? ` as <strong>${escapeHtml(name)}</strong>` : '';
  const signOutBtn = renderButton({
    className: 'q-touch',
    variant: 'ghost',
    size: 'sm',
    attrs: { 'data-q-sign-out': 'true' },
    children: 'Sign out',
  });
  return `<div class="flex items-center justify-between gap-3"><p>Signed in${who}.</p>${signOutBtn}</div>`;
}

function renderClosedHtml(night: Snapshot['night']): string {
  const detail =
    night?.status === 'closed' ? 'Tonight’s session has ended.' : 'No night session has started yet.';
  return renderCard({
    children: `<h2 class="ph-headline text-3xl">Requests are closed</h2><p>${detail}</p>`,
  });
}

function renderAllowanceHtml(quota: Snapshot['quota']): string {
  if (!quota) return '';
  const boxes = Array.from({ length: quota.limit }, (_, i) => {
    const cls = i < quota.remaining ? 'size-4 border border-primary bg-primary' : 'size-4 border border-input';
    return `<span class="${cls}"></span>`;
  }).join('');
  return `<section class="flex items-center gap-3 border border-border bg-card px-4 py-3" aria-label="Your allowance tonight"><div class="flex gap-1.5" aria-hidden="true">${boxes}</div><p><strong>${quota.remaining}</strong> of ${quota.limit} requests left tonight</p></section>`;
}

function renderFormStatusHtml(state: FlowState, remaining: number): string {
  const exhausted = remaining === 0 && state.phase !== 'submitted';
  const copy = state.error ? describeError(state.error) : null;
  const disambiguation =
    state.error?.code === 'SOURCE_UNAVAILABLE' ? readDisambiguation(state.error.details) : null;

  const parts: string[] = [];
  if (exhausted) {
    parts.push(renderNotice('info', 'You’ve used all your requests tonight.'));
  }

  if (copy && !disambiguation) {
    const retryLine =
      copy.retry && state.phase === 'previewed'
        ? '<p>Tap “Add to queue” again to retry; it won’t be counted twice.</p>'
        : '';
    parts.push(
      renderNotice(
        copy.tone,
        `<strong>${escapeHtml(copy.title)}</strong><p>${escapeHtml(copy.body)}</p>${retryLine}`,
        'alert',
      ),
    );
  }

  if (copy && disambiguation) {
    const reqLine = disambiguation.requested
      ? `<p>You asked for: ${escapeHtml(disambiguation.requested.title)} — ${escapeHtml(disambiguation.requested.artist ?? '')} (${escapeHtml(formatDuration(disambiguation.requested.durationSec))})</p>`
      : '';
    const candidatesHtml =
      disambiguation.candidates.length > 0
        ? `<ul class="q-candidates">${disambiguation.candidates
            .map((candidate) => {
              const notes = candidate.notes.length > 0 ? ` · ${candidate.notes.join(', ')}` : '';
              const btn = renderButton({
                className: 'q-touch',
                variant: 'outline',
                size: 'sm',
                attrs: { 'data-candidate-url': candidate.url },
                children: 'Use this one',
              });
              return `<li class="flex items-center justify-between gap-3 border border-border p-3"><span class="min-w-0"><strong>${escapeHtml(candidate.title)}</strong><br /><span>${escapeHtml(candidate.channel)} · ${escapeHtml(formatDuration(candidate.durationSec))}${escapeHtml(notes)}</span></span>${btn}</li>`;
            })
            .join('')}</ul>`
        : '';
    parts.push(
      renderNotice(
        'warn',
        `<strong>${escapeHtml(copy.title)}</strong><p>${escapeHtml(copy.body)}</p>${reqLine}${candidatesHtml}<p>Choose one above, or paste the exact YouTube link you want.</p>`,
        'alert',
      ),
    );
  }

  if (state.preview) {
    const { source, match, verdict } = state.preview;
    const track = match ?? source;
    const submitting = state.phase === 'submitting';
    const reject = verdict.accepted
      ? null
      : describeError({ code: verdict.code, message: verdict.message, retryable: false });
    const matchHtml = `<div class="q-match flex flex-col gap-1 p-3"><p class="ph-subheadline text-[12px]">Found match:</p><p class="q-text"><strong>${escapeHtml(track.title)}</strong></p><p class="q-text">${escapeHtml(track.artist ?? 'Unknown artist')} · ${escapeHtml(formatDuration(track.durationSec))}</p></div><p>Not the version you meant? Paste an exact YouTube link instead.</p>`;
    const actionHtml = reject
      ? renderNotice(
          reject.tone,
          `<strong>${escapeHtml(reject.title)}</strong><p>${escapeHtml(reject.body)}</p>`,
          'alert',
        )
      : renderDitherButton({
          className: 'q-wide',
          disabled: submitting,
          attrs: { 'data-q-submit': 'true' },
          children: submitting ? 'Adding…' : 'Add to queue',
        });
    parts.push(`<div class="flex flex-col gap-3">${matchHtml}${actionHtml}</div>`);
  }

  return parts.join('');
}

function renderMyRequestsHtml(entries: RequestEntryView[]): string {
  const inner =
    entries.length === 0
      ? '<p>No requests yet.</p>'
      : `<ul class="q-list">${entries
          .map((entry) => {
            const copy = STATUS_COPY[entry.status];
            const badge =
              entry.status !== 'preparing'
                ? renderBadge({ color: STATUS_BADGE[copy.tone], children: escapeHtml(copy.label) })
                : '';
            return `<li class="flex flex-col gap-1 border border-border p-3"><div class="flex items-start justify-between gap-3"><strong class="q-text">${escapeHtml(entry.title)}</strong>${badge}</div><p class="q-text">${escapeHtml(entry.artist ?? 'Unknown artist')} · ${escapeHtml(formatDuration(entry.durationSec))}</p></li>`;
          })
          .join('')}</ul>`;
  return renderCard({ children: `<h2 class="ph-headline text-3xl">Your requests</h2>${inner}` });
}

function renderLineupHtml(entries: RequestEntryView[]): string {
  const lineup = entries.filter((r) => r.status === 'playing' || WAITING.has(r.status));
  if (lineup.length === 0) return '';
  const items = lineup
    .map((entry) => {
      const strongCls = entry.mine ? ' class="text-primary"' : '';
      const artist = entry.artist ? `<span> ${escapeHtml(entry.artist)}</span>` : '';
      const playing = entry.status === 'playing' ? ` ${renderBadge({ color: 'yellow', children: 'Playing now' })}` : '';
      const mine = entry.mine ? ` ${renderBadge({ color: 'outline', children: 'Yours' })}` : '';
      return `<li class="q-text"><strong${strongCls}>${escapeHtml(entry.title)}</strong>${artist}${playing}${mine}</li>`;
    })
    .join('');
  return renderCard({
    children: `<h2 class="ph-headline text-3xl">In the queue</h2><ol class="q-lineup">${items}</ol>`,
  });
}

export function mountQueuePage(): () => void {
  const errorHost = document.getElementById('q-stream-error');
  const bodyHost = document.getElementById('q-body');
  if (!errorHost || !bodyHost) return () => {};

  const flow = new RequestFlow(sendCommand, sessionIntentStore());
  let snapshot: Snapshot | null = null;
  let streamError: string | null = null;
  let name: string | null = null;
  let renderedMode: string | null = null;
  let renderedFormKind: 'open-form' | 'submitted' | null = null;
  let accountHtmlCache = '';
  let allowanceHtmlCache = '';
  let formStatusHtmlCache = '';
  let myRequestsHtmlCache = '';
  let lineupHtmlCache = '';

  const buildFormShell = (target: HTMLElement) => {
    const fieldHtml = renderField({
      label: 'Paste a YouTube, Spotify, or Apple Music track link',
      forId: 'q-link',
      children: renderInput({
        attrs: {
          id: 'q-link',
          type: 'url',
          inputmode: 'url',
          autocomplete: 'off',
          autocapitalize: 'none',
          spellcheck: 'false',
          placeholder: 'https://…',
        },
      }),
    });
    const searchBtn = renderButton({
      className: 'q-touch',
      type: 'submit',
      attrs: { 'data-q-search': 'true' },
      children: 'Search',
    });
    const cancelBtn = renderButton({
      className: 'q-touch',
      variant: 'outline',
      attrs: { 'data-q-cancel': 'true' },
      children: 'Cancel',
    });

    target.innerHTML = renderCard({
      children: `<h2 class="ph-headline text-3xl">Request a song</h2><form class="flex flex-col gap-3" data-q-form>${fieldHtml}<div class="flex flex-wrap gap-2" data-q-form-actions>${searchBtn}</div></form><div class="q-list" data-q-form-status></div>`,
    });

    const form = target.querySelector<HTMLFormElement>('[data-q-form]');
    const input = target.querySelector<HTMLInputElement>('#q-link');
    const actionsBox = target.querySelector<HTMLElement>('[data-q-form-actions]');
    const statusBox = target.querySelector<HTMLElement>('[data-q-form-status]');
    const cancelHost = document.createElement('div');
    cancelHost.innerHTML = cancelBtn;
    const cancelEl = cancelHost.firstElementChild as HTMLButtonElement | null;

    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      void flow.check();
    });
    input?.addEventListener('input', () => {
      flow.setUrl(input.value);
    });
    actionsBox?.addEventListener('click', (event) => {
      if ((event.target as HTMLElement | null)?.closest('[data-q-cancel]')) {
        flow.reset();
      }
    });
    if (cancelEl) {
      actionsBox?.dataset && (actionsBox.dataset.hasCancelTemplate = 'true');
      (target as HTMLElement & { __qCancelEl?: HTMLButtonElement }).__qCancelEl = cancelEl;
    }
    statusBox?.addEventListener('click', (event) => {
      const targetEl = event.target as HTMLElement | null;
      const candBtn = targetEl?.closest<HTMLElement>('[data-candidate-url]');
      if (candBtn?.dataset.candidateUrl) {
        flow.setUrl(candBtn.dataset.candidateUrl);
        void flow.check();
        return;
      }
      if (targetEl?.closest('[data-q-submit]')) {
        void flow.submit();
      }
    });
  };

  const render = () => {
    if (streamError) {
      errorHost.hidden = false;
      errorHost.innerHTML = renderNotice(
        'warn',
        `Reconnecting… what you see may be out of date. (${escapeHtml(streamError)})`,
        'status',
      );
    } else {
      errorHost.hidden = true;
      errorHost.replaceChildren();
    }

    if (!snapshot) {
      if (renderedMode !== 'connecting') {
        renderedMode = 'connecting';
        renderedFormKind = null;
        bodyHost.innerHTML = '<p role="status">Connecting…</p>';
      }
      return;
    }

    const signedIn = snapshot.role !== 'public';
    const open = snapshot.night?.status === 'open';

    if (!signedIn) {
      const key = `signed-out:${open}`;
      if (renderedMode !== key) {
        renderedMode = key;
        renderedFormKind = null;
        bodyHost.innerHTML = renderSignIn(open);
      }
      return;
    }

    const state = flow.snapshot;
    const mine = snapshot.requests.filter((r) => r.mine);
    const modeKey = open ? 'signed-in:open' : 'signed-in:closed';

    if (renderedMode !== modeKey) {
      renderedMode = modeKey;
      renderedFormKind = null;
      accountHtmlCache = '';
      allowanceHtmlCache = '';
      formStatusHtmlCache = '';
      myRequestsHtmlCache = '';
      lineupHtmlCache = '';
      bodyHost.innerHTML = `
        <div data-q-account></div>
        ${open ? '<div data-q-allowance></div><div data-q-request-box></div>' : `<div data-q-closed></div>`}
        <div data-q-mine></div>
        <div data-q-lineup></div>
      `;
    }

    const accountHost = bodyHost.querySelector<HTMLElement>('[data-q-account]');
    if (accountHost) {
      const nextAccount = renderAccountHtml(name);
      if (nextAccount !== accountHtmlCache) {
        accountHtmlCache = nextAccount;
        accountHost.innerHTML = nextAccount;
      }
    }

    if (!open) {
      const closedHost = bodyHost.querySelector<HTMLElement>('[data-q-closed]');
      const closedHtml = renderClosedHtml(snapshot.night);
      if (closedHost && closedHost.innerHTML !== closedHtml) {
        closedHost.innerHTML = closedHtml;
      }
    } else {
      const allowanceHost = bodyHost.querySelector<HTMLElement>('[data-q-allowance]');
      if (allowanceHost) {
        const nextAllowance = renderAllowanceHtml(snapshot.quota);
        if (nextAllowance !== allowanceHtmlCache) {
          allowanceHtmlCache = nextAllowance;
          allowanceHost.innerHTML = nextAllowance;
        }
      }

      const requestHost = bodyHost.querySelector<HTMLElement>('[data-q-request-box]');
      if (requestHost) {
        const remaining = snapshot.quota?.remaining ?? 0;
        if (state.phase === 'submitted' && state.submitted) {
          if (renderedFormKind !== 'submitted') {
            renderedFormKind = 'submitted';
            formStatusHtmlCache = '';
            const againBtn = renderButton({
              className: 'q-touch',
              attrs: { 'data-q-another': 'true' },
              children: 'Request another',
            });
            requestHost.innerHTML = renderCard({
              className: 'q-success',
              children: `<div role="status" class="flex flex-col gap-3"><h2 class="ph-headline text-3xl text-primary">Added to the queue</h2>${againBtn}</div>`,
            });
          }
        } else {
          if (renderedFormKind !== 'open-form') {
            renderedFormKind = 'open-form';
            formStatusHtmlCache = '';
            buildFormShell(requestHost);
          }

          const busy = state.phase === 'checking' || state.phase === 'submitting';
          const exhausted = remaining === 0 && state.phase !== 'submitted';
          const input = requestHost.querySelector<HTMLInputElement>('#q-link');
          const searchBtn = requestHost.querySelector<HTMLButtonElement>('[data-q-search]');
          const actionsBox = requestHost.querySelector<HTMLElement>('[data-q-form-actions]');
          const cancelEl = (requestHost as HTMLElement & { __qCancelEl?: HTMLButtonElement }).__qCancelEl;
          const statusBox = requestHost.querySelector<HTMLElement>('[data-q-form-status]');

          if (input) {
            input.disabled = exhausted || state.phase === 'submitting';
            if (document.activeElement !== input && input.value !== state.url) {
              input.value = state.url;
            }
          }
          if (searchBtn) {
            searchBtn.disabled = busy || exhausted || state.url.trim() === '';
            const nextLabel =
              state.phase === 'checking'
                ? '<span class="q-searching-label">Searching for YouTube download…</span>'
                : 'Search';
            if (searchBtn.innerHTML !== nextLabel) searchBtn.innerHTML = nextLabel;
          }
          if (actionsBox && cancelEl) {
            const showCancel = Boolean(state.url || state.error || state.preview);
            if (showCancel && !cancelEl.isConnected) {
              actionsBox.append(cancelEl);
            } else if (!showCancel && cancelEl.isConnected) {
              cancelEl.remove();
            }
            cancelEl.disabled = state.phase === 'submitting';
          }
          if (statusBox) {
            const nextStatusHtml = renderFormStatusHtml(state, remaining);
            if (nextStatusHtml !== formStatusHtmlCache) {
              formStatusHtmlCache = nextStatusHtml;
              statusBox.innerHTML = nextStatusHtml;
            }
          }
        }
      }
    }

    const mineHost = bodyHost.querySelector<HTMLElement>('[data-q-mine]');
    if (mineHost) {
      const nextMine = renderMyRequestsHtml(mine);
      if (nextMine !== myRequestsHtmlCache) {
        myRequestsHtmlCache = nextMine;
        mineHost.innerHTML = nextMine;
      }
    }

    const lineupHost = bodyHost.querySelector<HTMLElement>('[data-q-lineup]');
    if (lineupHost) {
      const nextLineup = renderLineupHtml(snapshot.requests);
      if (nextLineup !== lineupHtmlCache) {
        lineupHtmlCache = nextLineup;
        lineupHost.innerHTML = nextLineup;
      }
    }
  };

  const onBodyClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-q-sign-out]')) {
      void (async () => {
        await fetch('/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        sessionStorage.removeItem('jukebox.pending-submit');
        window.location.reload();
      })();
      return;
    }
    if (target?.closest('[data-q-another]')) {
      flow.reset();
    }
  };
  bodyHost.addEventListener('click', onBodyClick);

  render();
  const stopFlow = flow.subscribe(() => render());
  const stopSnapshots = subscribeSnapshots(
    (next) => {
      snapshot = next;
      streamError = null;
      render();
    },
    (err) => {
      streamError = err;
      render();
    },
  );
  void fetchMe()
    .then((me) => {
      name = me.identity?.displayName ?? null;
      render();
    })
    .catch(() => undefined);

  return () => {
    bodyHost.removeEventListener('click', onBodyClick);
    stopFlow();
    stopSnapshots();
  };
}
