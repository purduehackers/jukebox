// Live admin state: SSE snapshots + a slow poll. The poll matters: player position heartbeats do not
// bump the revision (so SSE stays quiet), and an open SSE stream keeps its connect-time role after
// the session cookie expires. /api/v1/snapshot re-evaluates the cookie on every request.
import type { Snapshot } from '../../../src/contract/types.ts';
import { sendCommand, subscribeSnapshots } from '../shared/api.ts';
import { queueSignature, serverNowAt } from './derive.ts';
import { CommandRunner, VolumeController } from './intents.ts';
import type { Intent } from './intents.ts';

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

export interface LiveHandle extends Live {
  dispose(): void;
}

export function getServerNow(live: Pick<Live, 'snapshot' | 'receivedAt'>, localNow: number): number {
  return live.snapshot ? serverNowAt(live.snapshot, live.receivedAt, localNow) : localNow;
}

export function createLiveAdmin(onChange: () => void): LiveHandle {
  let snapshot: Snapshot | null = null;
  let receivedAt = 0;
  let access: Access = { state: 'loading' };
  let link: Link = 'connecting';
  let linkError: string | null = null;
  let externalChange = false;

  let disposed = false;
  let wasAdmin = false;
  let best: { revision: number; serverTime: number } | null = null;
  let signature: string | null = null;
  let selfChangeUntil = 0;
  /** Role from the last poll. Only a poll re-evaluates the session cookie, so it outranks SSE frames. */
  let polledRole: Snapshot['role'] | null = null;

  const notify = () => {
    if (!disposed) onChange();
  };

  function accept(next: Snapshot, source: 'poll' | 'sse'): boolean {
    if (source === 'poll') polledRole = next.role;
    else if (polledRole !== null && polledRole !== 'admin') return false; // stale-identity stream frame
    if (
      best &&
      (next.revision < best.revision ||
        (next.revision === best.revision && next.serverTime < best.serverTime))
    ) {
      return false;
    }
    best = { revision: next.revision, serverTime: next.serverTime };
    // The poll decides identity; a stale-admin SSE frame after expiry must not resurrect the console.
    if (next.role !== 'admin') {
      if (next.role === 'attendee') {
        access = { state: 'forbidden', name: access.state === 'forbidden' ? access.name : 'this account' };
      } else {
        access = { state: 'signed_out', expired: wasAdmin };
      }
      snapshot = null;
      return true;
    }
    wasAdmin = true;
    if (access.state !== 'admin') {
      access = { state: 'admin', name: access.state === 'forbidden' ? access.name : 'organizer' };
    }
    const sig = queueSignature(next);
    if (signature !== null && sig !== signature && Date.now() > selfChangeUntil) {
      externalChange = true;
    }
    signature = sig;
    snapshot = next;
    receivedAt = Date.now();
    return true;
  }

  async function poll() {
    try {
      const res = await fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' });
      if (disposed) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as Snapshot;
      if (disposed) return;
      if (next.role !== 'admin') best = null; // a role change is not "older" than the previous frame
      accept(next, 'poll');
      if (next.role !== 'public') {
        const me = (await (
          await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' })
        ).json()) as { identity: { displayName: string } | null };
        if (disposed) return;
        const name = me.identity?.displayName ?? 'organizer';
        if (access.state === 'admin' || access.state === 'forbidden') {
          access = { ...access, name };
        }
      }
      link = 'live';
      linkError = null;
      notify();
    } catch (error) {
      if (disposed) return;
      link = 'reconnecting';
      linkError = (error as Error).message;
      notify();
    }
  }

  void poll();
  const stopSnapshots = subscribeSnapshots(
    (next) => {
      if (accept(next, 'sse')) notify();
    },
    (message) => {
      if (message) {
        link = 'reconnecting';
        linkError = message;
        notify();
      }
    },
  );
  const timer = setInterval(() => void poll(), POLL_MS);
  const visible = () => {
    if (document.visibilityState === 'visible') void poll();
  };
  document.addEventListener('visibilitychange', visible);

  return {
    get snapshot() {
      return snapshot;
    },
    get receivedAt() {
      return receivedAt;
    },
    get access() {
      return access;
    },
    get link() {
      return link;
    },
    get linkError() {
      return linkError;
    },
    get externalChange() {
      return externalChange;
    },
    ackExternal() {
      externalChange = false;
      notify();
    },
    recheck() {
      void poll();
    },
    markOwn() {
      selfChangeUntil = Date.now() + 3000;
    },
    dispose() {
      disposed = true;
      stopSnapshots();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    },
  };
}

export interface Controls {
  runner: CommandRunner;
  volume: VolumeController;
  intents: readonly Intent[];
}

export interface ControlsHandle extends Controls {
  dispose(): void;
}

/** One runner per page; commands go through the shared client (stable ID, same-ID retries). */
export function createAdminControls(
  live: Pick<Live, 'recheck' | 'markOwn'>,
  onChange: () => void,
): ControlsHandle {
  const runner = new CommandRunner(async (type, payload, options) => {
    live.markOwn();
    const response = await sendCommand(type, payload, options);
    live.markOwn();
    if (!response.ok && (response.error.code === 'UNAUTHENTICATED' || response.error.code === 'FORBIDDEN')) {
      live.recheck();
    }
    return response;
  });
  const volume = new VolumeController(runner);
  const unsubscribe = runner.subscribe(() => onChange());

  return {
    runner,
    volume,
    get intents() {
      return runner.getSnapshot();
    },
    dispose() {
      unsubscribe();
      volume.dispose();
    },
  };
}
