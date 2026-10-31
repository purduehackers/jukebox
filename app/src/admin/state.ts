// Live admin state: SSE snapshots + a slow poll. The poll matters: player position heartbeats do not
// bump the revision (so SSE stays quiet), and an open SSE stream keeps its connect-time role after
// the session cookie expires. /api/v1/snapshot re-evaluates the cookie on every request.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Snapshot } from '../../../src/contract/types.ts';
import { sendCommand, subscribeSnapshots } from '../shared/api.ts';
import { CommandRunner, VolumeController } from './intents.ts';
import type { Intent } from './intents.ts';
import { queueSignature, serverNowAt } from './derive.ts';

export const POLL_MS = 4000;

export type Access =
  | { state: 'loading' }
  | { state: 'signed_out'; expired: boolean }
  | { state: 'forbidden'; name: string }
  | { state: 'admin'; name: string };

export type Link = 'connecting' | 'live' | 'reconnecting';

export interface Live {
  snapshot: Snapshot | null;
  /** Local time the snapshot was received, to extrapolate server time. */
  receivedAt: number;
  access: Access;
  link: Link;
  linkError: string | null;
  /** Another organizer changed a queue while you were looking; cleared by `ackExternal`. */
  externalChange: boolean;
  ackExternal(): void;
  recheck(): void;
  /** Call around your own commands so their effects are not reported as another organizer's. */
  markOwn(): void;
}

export function useLive(): Live {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [access, setAccess] = useState<Access>({ state: 'loading' });
  const [link, setLink] = useState<Link>('connecting');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const wasAdmin = useRef(false);
  const best = useRef<{ revision: number; serverTime: number } | null>(null);
  const signature = useRef<string | null>(null);
  const selfChangeUntil = useRef(0);
  /** Role from the last poll. Only a poll re-evaluates the session cookie, so it outranks SSE frames. */
  const polledRole = useRef<Snapshot['role'] | null>(null);

  function accept(next: Snapshot, source: 'poll' | 'sse') {
    if (source === 'poll') polledRole.current = next.role;
    else if (polledRole.current !== null && polledRole.current !== 'admin') return; // stale-identity stream frame
    const seen = best.current;
    if (seen && (next.revision < seen.revision || (next.revision === seen.revision && next.serverTime < seen.serverTime))) return;
    best.current = { revision: next.revision, serverTime: next.serverTime };
    // The poll decides identity; a stale-admin SSE frame after expiry must not resurrect the console.
    if (next.role !== 'admin') {
      setAccess((current) => {
        if (next.role === 'attendee') return { state: 'forbidden', name: current.state === 'forbidden' ? current.name : 'this account' };
        return { state: 'signed_out', expired: wasAdmin.current };
      });
      setSnapshot(null);
      return;
    }
    wasAdmin.current = true;
    setAccess((current) => (current.state === 'admin' ? current : { state: 'admin', name: current.state === 'forbidden' ? current.name : 'organizer' }));
    const sig = queueSignature(next);
    if (signature.current !== null && sig !== signature.current && Date.now() > selfChangeUntil.current) setExternalChange(true);
    signature.current = sig;
    setSnapshot(next);
    setReceivedAt(Date.now());
  }

  async function poll() {
    try {
      const res = await fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as Snapshot;
      if (next.role !== 'admin') best.current = null; // a role change is not "older" than the previous frame
      accept(next, 'poll');
      if (next.role !== 'public') {
        const me = (await (await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' })).json()) as { identity: { displayName: string } | null };
        const name = me.identity?.displayName ?? 'organizer';
        setAccess((current) => (current.state === 'admin' || current.state === 'forbidden' ? { ...current, name } : current));
      }
      setLink('live');
      setLinkError(null);
    } catch (error) {
      setLink('reconnecting');
      setLinkError((error as Error).message);
    }
  }

  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    void pollRef.current();
    const stop = subscribeSnapshots((next) => accept(next, 'sse'), (message) => {
      if (message) {
        setLink('reconnecting');
        setLinkError(message);
      }
    });
    const timer = setInterval(() => void pollRef.current(), POLL_MS);
    const visible = () => document.visibilityState === 'visible' && void pollRef.current();
    document.addEventListener('visibilitychange', visible);
    return () => {
      stop();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  return useMemo(() => ({
    snapshot, receivedAt, access, link, linkError, externalChange,
    ackExternal: () => setExternalChange(false),
    recheck: () => void pollRef.current(),
    markOwn: () => { selfChangeUntil.current = Date.now() + 3000; },
  }), [snapshot, receivedAt, access, link, linkError, externalChange]);
}

/** Re-render every `ms` so countdowns advance between snapshots. */
export function useTicker(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function useServerNow(live: Live, localNow: number) {
  return live.snapshot ? serverNowAt(live.snapshot, live.receivedAt, localNow) : localNow;
}

export interface Controls {
  runner: CommandRunner;
  volume: VolumeController;
  intents: readonly Intent[];
}

/** One runner per page; commands go through the shared client (stable ID, same-ID retries). */
export function useControls(live: Pick<Live, 'recheck' | 'markOwn'>): Controls {
  const liveRef = useRef(live);
  liveRef.current = live;
  const runner = useMemo(() => new CommandRunner(async (type, payload, options) => {
    liveRef.current.markOwn();
    const response = await sendCommand(type, payload, options);
    liveRef.current.markOwn();
    if (!response.ok && (response.error.code === 'UNAUTHENTICATED' || response.error.code === 'FORBIDDEN')) liveRef.current.recheck();
    return response;
  }), []);
  const volume = useMemo(() => new VolumeController(runner), [runner]);
  const intents = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  return { runner, volume, intents };
}
