// Attendee request page (QR destination). Silent: it never plays audio. All state shown here
// comes from the server snapshot; the browser only holds the link being typed and a retry aid.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RequestEntryView, Snapshot } from '../../../src/contract/types.ts';
import { fetchMe, sendCommand, useSnapshot } from '../shared/api.ts';
import { RequestFlow, sessionIntentStore } from './controller.ts';
import type { FlowState } from './controller.ts';
import { STATUS_COPY, WAITING, describeError, describeEstimate, estimateTurn, formatDuration, readDisambiguation } from './model.ts';
import './queue.css';

const PROVIDER_LABEL = { youtube: 'YouTube', spotify: 'Spotify', apple_music: 'Apple Music', fixture: 'Test fixture' } as const;

function useFlow() {
  const flow = useMemo(() => new RequestFlow(sendCommand, sessionIntentStore()), []);
  const state = useSyncExternalStore(flow.subscribe, () => flow.snapshot);
  return { flow, state };
}

/** Re-render periodically so "in about N minutes" tracks the server clock between snapshots. */
function useServerNow(snapshot: Snapshot | null) {
  const received = useMemo(() => ({ at: Date.now(), serverTime: snapshot?.serverTime ?? Date.now() }), [snapshot]);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  return received.serverTime + (Date.now() - received.at);
}

export function QueuePage() {
  const { snapshot, error: streamError } = useSnapshot();
  const { flow, state } = useFlow();
  const [name, setName] = useState<string | null>(null);
  const nowServer = useServerNow(snapshot);

  useEffect(() => {
    void fetchMe().then((me) => setName(me.identity?.displayName ?? null)).catch(() => undefined);
  }, []);

  const signedIn = snapshot !== null && snapshot.role !== 'public';
  const open = snapshot?.night?.status === 'open';
  const mine = snapshot?.requests.filter((r) => r.mine) ?? [];

  return (
    <main className="q-page">
      <header className="q-head">
        <h1>Jukebox</h1>
        <p className="q-sub">Request a song for the room. Audio plays on the venue speakers, not on your phone.</p>
      </header>

      {streamError && (
        <p className="q-note q-warn" role="status">Reconnecting… what you see may be out of date. ({streamError})</p>
      )}

      {!snapshot ? (
        <p className="q-note" role="status">Connecting…</p>
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
          <MyRequests entries={mine} snapshot={snapshot} nowServer={nowServer} />
          <Lineup entries={snapshot.requests} nowServer={nowServer} snapshot={snapshot} />
        </>
      )}

      <footer className="q-foot">
        <p>Audio only. Valid requests join the queue automatically; organizers can remove any of them.</p>
        <p>Request turns come about every 15 minutes of regular music. Wait estimates are rough and not guaranteed.</p>
      </footer>
    </main>
  );
}

function SignIn({ open }: { open: boolean }) {
  return (
    <section className="q-panel">
      <h2>Sign in to request</h2>
      <p>Requests use your Purdue Hackers ID, so everyone gets the same three songs per night.</p>
      {!open && <p className="q-note">No night is open right now. You can still sign in and check back later.</p>}
      <a className="q-button" href="/auth/login?returnTo=/queue">Sign in with Purdue Hackers ID</a>
    </section>
  );
}

function Account({ name }: { name: string | null }) {
  async function signOut() {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
    sessionStorage.removeItem('jukebox.pending-submit');
    window.location.reload();
  }
  return (
    <p className="q-account">
      Signed in{name ? <> as <strong>{name}</strong></> : ''}.{' '}
      <button className="q-link" type="button" onClick={() => void signOut()}>Sign out</button>
    </p>
  );
}

function Closed({ night }: { night: Snapshot['night'] }) {
  return (
    <section className="q-panel">
      <h2>Requests are closed</h2>
      <p>{night?.status === 'closed' ? 'Tonight’s session has ended.' : 'No night session has started yet.'} Organizers open a new session each night, and your allowance starts fresh.</p>
    </section>
  );
}

function Allowance({ quota }: { quota: Snapshot['quota'] }) {
  if (!quota) return null;
  return (
    <section className="q-allowance" aria-label="Your allowance tonight">
      <div className="q-pips" aria-hidden="true">
        {Array.from({ length: quota.limit }, (_, i) => <span key={i} className={i < quota.remaining ? 'q-pip q-pip-on' : 'q-pip'} />)}
      </div>
      <p>
        <strong>{quota.remaining}</strong> of {quota.limit} requests left tonight
        {quota.remaining === 0 && <> — you’ve used them all. Songs that fail to play are refunded.</>}
      </p>
    </section>
  );
}

function RequestForm({ flow, state, remaining }: { flow: RequestFlow; state: FlowState; remaining: number }) {
  const input = useRef<HTMLInputElement>(null);
  const busy = state.phase === 'checking' || state.phase === 'submitting';
  const copy = state.error ? describeError(state.error) : null;
  const disambiguation = state.error?.code === 'SOURCE_UNAVAILABLE' ? readDisambiguation(state.error.details) : null;
  const exhausted = remaining === 0 && state.phase !== 'submitted';

  useEffect(() => {
    if (state.phase === 'submitted') input.current?.blur();
  }, [state.phase]);

  if (state.phase === 'submitted' && state.submitted) {
    return (
      <section className="q-panel q-success" role="status">
        <h2>Added to the queue</h2>
        <p>{state.submitted.quota.remaining === 0 ? 'That was your last request tonight.' : `You have ${state.submitted.quota.remaining} left tonight.`} Track its progress below.</p>
        <button className="q-button" type="button" onClick={() => flow.reset()}>Request another</button>
      </section>
    );
  }

  return (
    <section className="q-panel">
      <h2>Request a song</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void flow.check();
        }}
      >
        <label htmlFor="q-link">Paste a YouTube, Spotify, or Apple Music track link</label>
        <input
          id="q-link"
          ref={input}
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
        <button className="q-button" type="submit" disabled={busy || exhausted || state.url.trim() === ''}>
          {state.phase === 'checking' ? 'Checking…' : 'Check link'}
        </button>
      </form>

      {exhausted && <p className="q-note">You’ve used all your requests tonight.</p>}

      {copy && !disambiguation && (
        <div className={`q-note q-${copy.tone}`} role="alert">
          <strong>{copy.title}</strong>
          <p>{copy.body}</p>
          {copy.retry && state.phase === 'previewed' && <p>Tap “Add to queue” again to retry; it won’t be counted twice.</p>}
        </div>
      )}

      {copy && disambiguation && (
        <div className="q-note q-warn" role="alert">
          <strong>{copy.title}</strong>
          <p>{copy.body}</p>
          {disambiguation.requested && (
            <p className="q-dim">You asked for: {disambiguation.requested.title} — {disambiguation.requested.artist} ({formatDuration(disambiguation.requested.durationSec)})</p>
          )}
          {disambiguation.candidates.length > 0 && (
            <ul className="q-candidates">
              {disambiguation.candidates.map((candidate) => (
                <li key={candidate.url}>
                  <span>
                    <strong>{candidate.title}</strong>
                    <br />
                    <span className="q-dim">{candidate.channel} · {formatDuration(candidate.durationSec)}{candidate.notes.length > 0 && ` · ${candidate.notes.join(', ')}`}</span>
                  </span>
                  <button
                    className="q-button q-small"
                    type="button"
                    onClick={() => {
                      flow.setUrl(candidate.url);
                      void flow.check();
                    }}
                  >
                    Use this one
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="q-dim">We never pick a different recording for you. Choose one above, or paste the exact YouTube link you want.</p>
        </div>
      )}

      {state.preview && <Preview flow={flow} state={state} />}
    </section>
  );
}

function Preview({ flow, state }: { flow: RequestFlow; state: FlowState }) {
  const preview = state.preview!;
  const { source, match, verdict } = preview;
  const submitting = state.phase === 'submitting';
  const reject = verdict.accepted ? null : describeError({ code: verdict.code, message: verdict.message, retryable: false });
  return (
    <div className="q-preview">
      <p className="q-eyebrow">{PROVIDER_LABEL[source.provider]} link</p>
      <p className="q-title">{source.title}</p>
      <p className="q-artist">{source.artist ?? 'Unknown artist'} · {formatDuration(source.durationSec)}</p>
      {match && (
        <div className="q-match">
          <p className="q-eyebrow">What will actually play</p>
          <p><strong>{match.title}</strong> · {match.artist ?? 'Unknown channel'} · {formatDuration(match.durationSec)} · audio from YouTube</p>
          <ul className="q-dim">{match.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <p className="q-dim">Not the version you meant? Paste the exact YouTube link instead.</p>
        </div>
      )}
      {reject ? (
        <div className={`q-note q-${reject.tone}`} role="alert">
          <strong>{reject.title}</strong>
          <p>{reject.body}</p>
        </div>
      ) : (
        <button className="q-button q-primary" type="button" disabled={submitting} onClick={() => void flow.submit()}>
          {submitting ? 'Adding…' : `Add to queue (uses 1 of your ${preview.quota.limit})`}
        </button>
      )}
      {!reject && <p className="q-dim">{preview.quota.remaining - 1} left after this. Removed or skipped songs still count; songs that fail to play are refunded.</p>}
    </div>
  );
}

function MyRequests({ entries, snapshot, nowServer }: { entries: RequestEntryView[]; snapshot: Snapshot; nowServer: number }) {
  if (entries.length === 0) {
    return (
      <section className="q-panel">
        <h2>Your requests</h2>
        <p className="q-dim">Nothing yet tonight. Finished requests stay listed for about an hour.</p>
      </section>
    );
  }
  return (
    <section className="q-panel">
      <h2>Your requests</h2>
      <ul className="q-list">
        {entries.map((entry) => {
          const copy = STATUS_COPY[entry.status];
          const estimate = WAITING.has(entry.status) ? describeEstimate(estimateTurn(snapshot, entry.id, nowServer)) : '';
          return (
            <li key={entry.id} className={`q-entry q-${copy.tone}`}>
              <div className="q-row">
                <span className="q-title">{entry.title}</span>
                <span className="q-badge">{copy.label}</span>
              </div>
              <p className="q-artist">{entry.artist ?? 'Unknown artist'} · {formatDuration(entry.durationSec)}</p>
              <p className="q-dim">{copy.detail}</p>
              {estimate && <p>{estimate}</p>}
              {entry.status === 'failed' && entry.error && <p className="q-dim">Reason: {entry.error}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Lineup({ entries, snapshot, nowServer }: { entries: RequestEntryView[]; snapshot: Snapshot; nowServer: number }) {
  const lineup = entries.filter((r) => r.status === 'playing' || WAITING.has(r.status));
  if (lineup.length === 0) return null;
  const waiting = lineup.filter((r) => WAITING.has(r.status));
  const next = waiting[0] ? estimateTurn(snapshot, waiting[0].id, nowServer) : null;
  return (
    <section className="q-panel">
      <h2>In the queue</h2>
      {next && <p className="q-dim">{describeEstimate(next)}</p>}
      <ol className="q-lineup">
        {lineup.map((entry) => (
          <li key={entry.id} className={entry.mine ? 'q-mine' : ''}>
            <span className="q-title">{entry.title}</span>
            <span className="q-dim"> {entry.artist ?? ''} {entry.status === 'playing' ? '· playing now' : entry.status === 'preparing' ? '· getting ready' : ''}{entry.mine ? ' · yours' : ''}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
