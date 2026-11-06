// Attendee request page (QR destination). Silent: it never plays audio. All state shown here
// comes from the server snapshot; the browser only holds the link being typed and a retry aid.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { RequestEntryView, Snapshot } from '../../../src/contract/types.ts';
import { Badge } from '../components/ph/badge.tsx';
import { Button } from '../components/ph/button.tsx';
import { Card } from '../components/ph/card.tsx';
import { DitherButton } from '../components/ph/dither-button.tsx';
import { Field } from '../components/ph/field.tsx';
import { Input } from '../components/ph/input.tsx';
import { fetchMe, sendCommand, useSnapshot } from '../shared/api.ts';
import '../shared/ph-ui.css';
import { RequestFlow, sessionIntentStore } from './controller.ts';
import type { FlowState } from './controller.ts';
import { STATUS_COPY, WAITING, describeError, formatDuration, readDisambiguation } from './model.ts';
import type { StatusCopy, Tone } from './model.ts';
import './queue.css';

function useFlow() {
  const flow = useMemo(() => new RequestFlow(sendCommand, sessionIntentStore()), []);
  const state = useSyncExternalStore(flow.subscribe, () => flow.snapshot);
  return { flow, state };
}

const NOTICE_BORDER: Record<Tone, string> = {
  info: 'border-ph-pink',
  warn: 'border-ph-yellow',
  error: 'border-ph-orange',
};

const STATUS_BADGE: Record<StatusCopy['tone'], 'pink' | 'yellow' | 'outline' | 'orange'> = {
  wait: 'pink',
  live: 'yellow',
  done: 'outline',
  problem: 'orange',
};

function Notice({ tone, role, children }: { tone: Tone; role?: 'alert' | 'status'; children: ReactNode }) {
  return (
    <div className={`q-notice border bg-card p-3 ${NOTICE_BORDER[tone]}`} role={role}>
      {children}
    </div>
  );
}

export function QueuePage() {
  const { snapshot, error: streamError } = useSnapshot();
  const { flow, state } = useFlow();
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    void fetchMe().then((me) => setName(me.identity?.displayName ?? null)).catch(() => undefined);
  }, []);

  const signedIn = snapshot !== null && snapshot.role !== 'public';
  const open = snapshot?.night?.status === 'open';
  const mine = snapshot?.requests.filter((r) => r.mine) ?? [];

  return (
    <main className="ph-ui dark q-page">
      <div className="q-shell">
        <header>
          <h1 className="ph-headline text-6xl text-primary">Jukebox</h1>
        </header>

        {streamError && (
          <Notice tone="warn" role="status">
            Reconnecting… what you see may be out of date. ({streamError})
          </Notice>
        )}

        {!snapshot ? (
          <p role="status">Connecting…</p>
        ) : !signedIn ? (
          <SignIn open={open} />
        ) : (
          <>
            <Account name={name} />
            {!open ? <Closed night={snapshot.night} /> : (
              <>
                <Allowance quota={snapshot.quota} />
                <RequestForm flow={flow} state={state} remaining={snapshot.quota?.remaining ?? 0} />
              </>
            )}
            <MyRequests entries={mine} />
            <Lineup entries={snapshot.requests} />
          </>
        )}
      </div>
    </main>
  );
}

function SignIn({ open }: { open: boolean }) {
  return (
    <Card>
      <h2 className="ph-headline text-3xl">Sign in to request</h2>
      {!open && <p>No night is open right now. You can still sign in and check back later.</p>}
      <DitherButton href="/auth/login?returnTo=/queue">Sign in with Purdue Hackers ID</DitherButton>
    </Card>
  );
}

function Account({ name }: { name: string | null }) {
  async function signOut() {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
    sessionStorage.removeItem('jukebox.pending-submit');
    window.location.reload();
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <p>
        Signed in{name ? <> as <strong>{name}</strong></> : ''}.
      </p>
      <Button className="q-touch" variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button>
    </div>
  );
}

function Closed({ night }: { night: Snapshot['night'] }) {
  return (
    <Card>
      <h2 className="ph-headline text-3xl">Requests are closed</h2>
      <p>{night?.status === 'closed' ? 'Tonight’s session has ended.' : 'No night session has started yet.'}</p>
    </Card>
  );
}

function Allowance({ quota }: { quota: Snapshot['quota'] }) {
  if (!quota) return null;
  return (
    <section className="flex items-center gap-3 border border-border bg-card px-4 py-3" aria-label="Your allowance tonight">
      <div className="flex gap-1.5" aria-hidden="true">
        {Array.from({ length: quota.limit }, (_, i) => (
          <span key={i} className={i < quota.remaining ? 'size-4 border border-primary bg-primary' : 'size-4 border border-input'} />
        ))}
      </div>
      <p>
        <strong>{quota.remaining}</strong> of {quota.limit} requests left tonight
      </p>
    </section>
  );
}

function RequestForm({ flow, state, remaining }: { flow: RequestFlow; state: FlowState; remaining: number }) {
  const busy = state.phase === 'checking' || state.phase === 'submitting';
  const copy = state.error ? describeError(state.error) : null;
  const disambiguation = state.error?.code === 'SOURCE_UNAVAILABLE' ? readDisambiguation(state.error.details) : null;
  const exhausted = remaining === 0 && state.phase !== 'submitted';

  if (state.phase === 'submitted' && state.submitted) {
    return (
      <Card className="q-success">
        <div role="status" className="flex flex-col gap-3">
          <h2 className="ph-headline text-3xl text-primary">Added to the queue</h2>
          <Button className="q-touch" onClick={() => flow.reset()}>Request another</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="ph-headline text-3xl">Request a song</h2>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void flow.check();
        }}
      >
        <Field label="Paste a YouTube, Spotify, or Apple Music track link" htmlFor="q-link">
          <Input
            id="q-link"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://…"
            value={state.url}
            disabled={exhausted || state.phase === 'submitting'}
            onChange={(event) => flow.setUrl(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button className="q-touch" type="submit" disabled={busy || exhausted || state.url.trim() === ''}>
            {state.phase === 'checking' ? 'Searching…' : 'Search'}
          </Button>
          {(state.url || state.error || state.preview) && (
            <Button className="q-touch" variant="outline" disabled={state.phase === 'submitting'} onClick={() => flow.reset()}>Cancel</Button>
          )}
        </div>
      </form>

      {exhausted && <Notice tone="info">You’ve used all your requests tonight.</Notice>}

      {copy && !disambiguation && (
        <Notice tone={copy.tone} role="alert">
          <strong>{copy.title}</strong>
          <p>{copy.body}</p>
          {copy.retry && state.phase === 'previewed' && <p>Tap “Add to queue” again to retry; it won’t be counted twice.</p>}
        </Notice>
      )}

      {copy && disambiguation && (
        <Notice tone="warn" role="alert">
          <strong>{copy.title}</strong>
          <p>{copy.body}</p>
          {disambiguation.requested && (
            <p>You asked for: {disambiguation.requested.title} — {disambiguation.requested.artist} ({formatDuration(disambiguation.requested.durationSec)})</p>
          )}
          {disambiguation.candidates.length > 0 && (
            <ul className="q-candidates">
              {disambiguation.candidates.map((candidate) => (
                <li key={candidate.url} className="flex items-center justify-between gap-3 border border-border p-3">
                  <span className="min-w-0">
                    <strong>{candidate.title}</strong>
                    <br />
                    <span>{candidate.channel} · {formatDuration(candidate.durationSec)}{candidate.notes.length > 0 && ` · ${candidate.notes.join(', ')}`}</span>
                  </span>
                  <Button
                    className="q-touch"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      flow.setUrl(candidate.url);
                      void flow.check();
                    }}
                  >
                    Use this one
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p>Choose one above, or paste the exact YouTube link you want.</p>
        </Notice>
      )}

      {state.preview && <Preview flow={flow} state={state} />}
    </Card>
  );
}

function Preview({ flow, state }: { flow: RequestFlow; state: FlowState }) {
  const preview = state.preview!;
  const { source, match, verdict } = preview;
  const track = match ?? source;
  const submitting = state.phase === 'submitting';
  const reject = verdict.accepted ? null : describeError({ code: verdict.code, message: verdict.message, retryable: false });
  return (
    <div className="flex flex-col gap-3">
      <div className="q-match flex flex-col gap-1 p-3">
        <p className="ph-subheadline text-[12px]">Found match:</p>
        <p className="q-text"><strong>{track.title}</strong></p>
        <p className="q-text">{track.artist ?? 'Unknown artist'} · {formatDuration(track.durationSec)}</p>
      </div>
      <p>Not the version you meant? Paste an exact YouTube link instead.</p>
      {reject ? (
        <Notice tone={reject.tone} role="alert">
          <strong>{reject.title}</strong>
          <p>{reject.body}</p>
        </Notice>
      ) : (
        <DitherButton className="q-wide" disabled={submitting} onClick={() => void flow.submit()}>
          {submitting ? 'Adding…' : 'Add to queue'}
        </DitherButton>
      )}
    </div>
  );
}

function MyRequests({ entries }: { entries: RequestEntryView[] }) {
  return (
    <Card>
      <h2 className="ph-headline text-3xl">Your requests</h2>
      {entries.length === 0 ? (
        <p>No requests yet.</p>
      ) : (
        <ul className="q-list">
          {entries.map((entry) => {
            const copy = STATUS_COPY[entry.status];
            return (
              <li key={entry.id} className="flex flex-col gap-1 border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <strong className="q-text">{entry.title}</strong>
                  {entry.status !== 'preparing' && <Badge color={STATUS_BADGE[copy.tone]}>{copy.label}</Badge>}
                </div>
                <p className="q-text">{entry.artist ?? 'Unknown artist'} · {formatDuration(entry.durationSec)}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Lineup({ entries }: { entries: RequestEntryView[] }) {
  const lineup = entries.filter((r) => r.status === 'playing' || WAITING.has(r.status));
  if (lineup.length === 0) return null;
  return (
    <Card>
      <h2 className="ph-headline text-3xl">In the queue</h2>
      <ol className="q-lineup">
        {lineup.map((entry) => (
          <li key={entry.id} className="q-text">
            <strong className={entry.mine ? 'text-primary' : undefined}>{entry.title}</strong>
            {entry.artist ? <span> {entry.artist}</span> : null}
            {entry.status === 'playing' && <> <Badge color="yellow">Playing now</Badge></>}
            {entry.mine && <> <Badge color="outline">Yours</Badge></>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
