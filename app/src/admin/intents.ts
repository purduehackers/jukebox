// User intents -> commands. One intent = one commandId, reused for every retry of that intent,
// so a flaky network can never apply an action twice. No React; the sender is injected.
import type { ApiError, CommandPayloads, CommandResponse, CommandType } from '../../../src/contract/types.ts';

export type Send = <T extends CommandType>(
  type: T,
  payload: CommandPayloads[T],
  options: { commandId: string; expectedRevision?: number },
) => Promise<CommandResponse<T>>;

export type IntentStatus = 'pending' | 'ok' | 'failed';

export interface Intent {
  /** Stable for the life of the intent; also the commandId sent to the server. */
  id: string;
  label: string;
  type: CommandType;
  payload: unknown;
  expectedRevision?: number;
  status: IntentStatus;
  error: ApiError | null;
  /** The server answered from its stored result for this commandId. */
  replayed: boolean;
  startedAt: number;
  finishedAt: number | null;
  attempts: number;
  result?: unknown;
}

const HISTORY = 12;

export class CommandRunner {
  private intents: Intent[] = [];
  private listeners = new Set<() => void>();
  private readonly send: Send;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(send: Send, options: { now?: () => number; newId?: () => string } = {}) {
    this.send = send;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Immutable snapshot for useSyncExternalStore: changes identity on every update. */
  getSnapshot = (): readonly Intent[] => this.intents;

  private update(id: string, change: Partial<Intent>) {
    this.intents = this.intents.map((intent) => (intent.id === id ? { ...intent, ...change } : intent));
    for (const listener of this.listeners) listener();
  }

  /** Start a new user decision. Resolves with the final intent (never throws). */
  async run<T extends CommandType>(label: string, type: T, payload: CommandPayloads[T], options: { expectedRevision?: number } = {}): Promise<Intent> {
    const id = this.newId();
    const intent: Intent = {
      id, label, type, payload, expectedRevision: options.expectedRevision, status: 'pending', error: null, replayed: false,
      startedAt: this.now(), finishedAt: null, attempts: 0,
    };
    this.intents = [intent, ...this.intents].slice(0, HISTORY);
    for (const listener of this.listeners) listener();
    return this.dispatch(id);
  }

  /**
   * Resend a failed intent with its original commandId. Only meaningful for retryable failures
   * (network, internal): a deterministic rejection is stored server-side and would simply replay.
   */
  async retry(id: string): Promise<Intent | null> {
    const intent = this.intents.find((i) => i.id === id);
    if (!intent || intent.status !== 'failed') return null;
    this.update(id, { status: 'pending', error: null });
    return this.dispatch(id);
  }

  dismiss(id: string) {
    this.intents = this.intents.filter((i) => i.id !== id || i.status === 'pending');
    for (const listener of this.listeners) listener();
  }

  private async dispatch(id: string): Promise<Intent> {
    const intent = this.intents.find((i) => i.id === id)!;
    this.update(id, { attempts: intent.attempts + 1 });
    let response: CommandResponse;
    try {
      response = await this.send(intent.type, intent.payload as never, { commandId: id, expectedRevision: intent.expectedRevision });
    } catch (error) {
      response = { ok: false, commandId: id, replayed: false, error: { code: 'INTERNAL', message: `Network error: ${(error as Error).message}`, retryable: true } };
    }
    this.update(id, response.ok
      ? { status: 'ok', replayed: response.replayed, finishedAt: this.now(), result: response.result }
      : { status: 'failed', error: response.error, replayed: response.replayed, finishedAt: this.now() });
    return this.intents.find((i) => i.id === id)!;
  }
}

// ------------------------------------------------------------ slider traffic

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const realTimers: Timers = { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() };

/**
 * Bounds volume-slider traffic: at most one command in flight, at most one send per
 * `minIntervalMs`, intermediate drag values coalesced, and the last value always delivered.
 * Each sent value is its own intent (own commandId), so ordering never relies on retries.
 */
export class VolumeController {
  private target: number | null = null;
  private lastSent: number | null = null;
  private lastSentAt = -Infinity;
  private inFlight = false;
  private timer: unknown = null;
  sent = 0;
  private readonly runner: CommandRunner;
  private readonly timers: Timers;
  private readonly minIntervalMs: number;
  /** Notified whenever the pending (not yet delivered) value changes. */
  onPending: (pending: number | null) => void = () => undefined;

  constructor(runner: CommandRunner, options: { minIntervalMs?: number; timers?: Timers } = {}) {
    this.runner = runner;
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.timers = options.timers ?? realTimers;
  }

  set(volume: number) {
    this.target = Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
    this.onPending(this.target);
    this.pump();
  }

  get pending() {
    return this.target !== null;
  }

  private pump() {
    if (this.inFlight || this.timer !== null || this.target === null || this.target === this.lastSent) return;
    const wait = this.lastSentAt + this.minIntervalMs - this.timers.now();
    if (wait > 0) {
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    const value = this.target;
    this.inFlight = true;
    this.lastSentAt = this.timers.now();
    this.sent++;
    void this.runner.run(`Set volume ${Math.round(value * 100)}%`, 'playback.volume', { volume: value }).then((intent) => {
      this.inFlight = false;
      if (intent.status === 'ok') this.lastSent = value;
      if (this.target === value) {
        this.target = null; // delivered, or failed and not superseded: the error shows in the activity list
        this.onPending(null);
      }
      this.pump();
    });
  }
}
