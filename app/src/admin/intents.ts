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
  revision?: number;
}

const HISTORY = 12;
const isAdd = (type: CommandType) => type === 'master.add' || type === 'request.submit';

export class CommandRunner {
  private intents: Intent[] = [];
  private listeners = new Set<() => void>();
  private readonly send: Send;
  private playbackTail: Promise<unknown> = Promise.resolve();
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
    const pending = isAdd(type) && this.intents.find((i) => isAdd(i.type) && i.status === 'pending');
    if (pending) return this.waitFor(pending.id);
    const id = this.newId();
    const intent: Intent = {
      id, label, type, payload, expectedRevision: options.expectedRevision, status: 'pending', error: null, replayed: false,
      startedAt: this.now(), finishedAt: null, attempts: 0,
    };
    this.intents = [intent, ...this.intents].filter((item, index) => index < HISTORY || item.status === 'pending');
    for (const listener of this.listeners) listener();
    return this.enqueue(id, type);
  }

  /**
   * Resend a failed intent with its original commandId. Only meaningful for retryable failures
   * (network, internal): a deterministic rejection is stored server-side and would simply replay.
   */
  async retry(id: string): Promise<Intent | null> {
    const intent = this.intents.find((i) => i.id === id);
    if (!intent || intent.status !== 'failed') return null;
    const pending = isAdd(intent.type) && this.intents.find((i) => isAdd(i.type) && i.status === 'pending');
    if (pending) return this.waitFor(pending.id);
    this.update(id, { status: 'pending', error: null });
    return this.enqueue(id, intent.type);
  }

  /** Join the active add instead of creating a second submission before React renders. */
  private waitFor(id: string): Promise<Intent> {
    return new Promise((resolve) => {
      const stop = this.subscribe(() => {
        const intent = this.intents.find((i) => i.id === id);
        if (intent && intent.status !== 'pending') {
          stop();
          resolve(intent);
        }
      });
    });
  }

  private enqueue(id: string, type: CommandType): Promise<Intent> {
    if (!type.startsWith('playback.')) return this.dispatch(id);
    const dispatched = this.playbackTail.then(() => this.dispatch(id));
    this.playbackTail = dispatched.catch(() => undefined);
    return dispatched;
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
      ? { status: 'ok', replayed: response.replayed, finishedAt: this.now(), result: response.result, revision: response.revision }
      : { status: 'failed', error: response.error, replayed: response.replayed, finishedAt: this.now() });
    return this.intents.find((i) => i.id === id) ?? intent;
  }
}

// ------------------------------------------------------------ slider traffic

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const realTimers: Timers = { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() };

/** Debounce adjustments; serialize sends and retain only the latest queued value. */
export class VolumeController {
  private target: number | null = null;
  private inFlight = false;
  private timer: unknown = null;
  private ready = false;
  private dragging = false;
  sent = 0;
  private readonly runner: CommandRunner;
  private readonly timers: Timers;
  private readonly minIntervalMs: number;
  onPending: (pending: number | null) => void = () => undefined;

  constructor(runner: CommandRunner, options: { minIntervalMs?: number; timers?: Timers } = {}) {
    this.runner = runner;
    this.minIntervalMs = options.minIntervalMs ?? 300;
    this.timers = options.timers ?? realTimers;
  }

  begin() {
    this.dragging = true;
    this.ready = false;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  set(volume: number) {
    this.target = Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
    this.onPending(this.target);
    this.ready = false;
    if (this.timer !== null) this.timers.clear(this.timer);
    if (this.dragging) return;
    this.timer = this.timers.set(() => { this.timer = null; this.flush(); }, this.minIntervalMs);
  }

  flush() {
    this.dragging = false;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.ready = true;
    this.pump();
  }

  dispose() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.target = null;
    this.ready = false;
    this.onPending = () => undefined;
  }

  get pending() { return this.target !== null; }

  private pump() {
    if (this.inFlight || !this.ready || this.target === null) return;
    const value = this.target;
    this.ready = false;
    this.inFlight = true;
    this.sent++;
    void this.runner.run(`Set volume ${Math.round(value * 100)}%`, 'playback.volume', { volume: value }).then(() => {
      this.inFlight = false;
      if (this.target === value && this.timer === null) {
        this.target = null;
        this.onPending(null);
      }
      this.pump();
    });
  }
}
