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
  let backoff = 500;
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
            if (snapshot.revision < latest) continue;
            latest = snapshot.revision;
            onSnapshot(snapshot);
          }
        }
        throw new Error('Stream closed');
      } catch (error) {
        if (controller.signal.aborted) return;
        onError((error as Error).message);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  })();
  return () => controller.abort();
}

export function useSnapshot(bearer?: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => subscribeSnapshots(setSnapshot, setError, bearer), [bearer]);
  return { snapshot, error };
}
