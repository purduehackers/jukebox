// Browser client for the v1 contract. Owned by the integration owner; UI phases use it
// rather than hand-rolling fetches so retries and stale-state rules stay consistent.
import { useEffect, useState } from 'react';
import type { CommandPayloads, CommandResponse, CommandType, Snapshot } from '../../../src/contract/types.ts';

export type { Snapshot };

export interface CommandOptions {
  /** Reuse to retry the same intent; generated once per call otherwise. */
  commandId?: string;
  expectedRevision?: number;
  /** Paired-device token (player only). Cookie sessions are sent automatically. */
  bearer?: string;
  /** Retries of the SAME commandId on network failure or retryable errors. */
  attempts?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send a command with a stable commandId. Network failures and `retryable` errors are
 * retried with the same ID, so the server replays instead of executing twice.
 */
export async function sendCommand<T extends CommandType>(type: T, payload: CommandPayloads[T], options: CommandOptions = {}): Promise<CommandResponse<T>> {
  const commandId = options.commandId ?? crypto.randomUUID();
  const attempts = options.attempts ?? 3;
  let last: CommandResponse<T> | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(300 * 2 ** (attempt - 1));
    try {
      const res = await fetch('/api/v1/commands', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}) },
        body: JSON.stringify({ commandId, type, payload, expectedRevision: options.expectedRevision }),
      });
      last = await res.json() as CommandResponse<T>;
      if (last.ok || !last.error.retryable) return last;
    } catch (error) {
      last = { ok: false, commandId, replayed: false, error: { code: 'INTERNAL', message: `Network error: ${(error as Error).message}`, retryable: true } };
    }
  }
  return last!;
}

export async function fetchMe(): Promise<{ role: Snapshot['role']; identity: { displayName: string; roles: string[] } | null }> {
  return (await fetch('/auth/me', { credentials: 'same-origin' })).json();
}

/**
 * Stream role-scoped snapshots (SSE over fetch so a device bearer header works).
 * Never delivers a snapshot older than one already delivered; reconnects with backoff
 * and always receives the current snapshot on reconnect.
 */
export function subscribeSnapshots(onSnapshot: (snapshot: Snapshot) => void, onError: (message: string | null) => void, bearer?: string) {
  const controller = new AbortController();
  let latest = -1;
  let latestTime = -1;
  let fetching = false;
  let lastSuccess = -Infinity;
  let backoff = 500;
  let expediteReconnect: (() => void) | null = null;
  const deliver = (snapshot: Snapshot) => {
    if (controller.signal.aborted || snapshot.revision < latest || (snapshot.revision === latest && snapshot.serverTime < latestTime)) return;
    latest = snapshot.revision;
    latestTime = snapshot.serverTime;
    lastSuccess = performance.now();
    onSnapshot(snapshot);
  };
  // Render the initial (often tiny, empty-session) state immediately, even if a
  // browser or development proxy buffers the first few SSE bytes.
  const refresh = async () => {
    if (fetching || controller.signal.aborted) return;
    fetching = true;
    try {
      const res = await fetch('/api/v1/snapshot', {
        credentials: 'same-origin', headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      deliver(await res.json() as Snapshot);
      if (!controller.signal.aborted) {
        onError(null);
        // A healthy poll proves the server is back. Do not keep a failed SSE
        // connection in its old ten-second retry delay while controls are live.
        if (backoff > 500) { backoff = 500; expediteReconnect?.(); }
      }
    } catch (error) {
      if (!controller.signal.aborted && performance.now() - lastSuccess > 5000) onError((error as Error).message);
    } finally { fetching = false; }
  };
  void refresh();
  // Reconcile after a backend restart even when a browser/proxy leaves an old
  // event-stream connection stalled. Polling reads the same authoritative state.
  const poll = setInterval(() => void refresh(), 5000);
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch('/api/v1/stream', {
          credentials: 'same-origin',
          headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onError(null);
        backoff = 500;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = block.split('\n').find((line) => line.startsWith('data: '));
            if (!data) continue;
            const snapshot = JSON.parse(data.slice(6)) as Snapshot;
            deliver(snapshot);
          }
        }
        throw new Error('Stream closed');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (performance.now() - lastSuccess > 5000) onError((error as Error).message);
        void refresh();
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); expediteReconnect = null; controller.signal.removeEventListener('abort', done); resolve(); };
          let timer = setTimeout(done, backoff);
          expediteReconnect = () => { clearTimeout(timer); timer = setTimeout(done, 500); };
          controller.signal.addEventListener('abort', done, { once: true });
          if (controller.signal.aborted) done();
        });
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  })();
  return () => { clearInterval(poll); controller.abort(); };
}

export function useSnapshot(bearer?: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => subscribeSnapshots(setSnapshot, setError, bearer), [bearer]);
  return { snapshot, error };
}
