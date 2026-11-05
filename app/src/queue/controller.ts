// Framework-free state machine for "paste a link → see what will play → submit".
// The React page only renders its state. Keeping it here lets tests drive double taps,
// retries, and stale responses against the real service without a browser.
import type { ApiError, CommandPayloads, CommandResponse, CommandResult, PreviewResult } from '../../../src/contract/types.ts';

type SendCommand = <T extends 'request.preview' | 'request.submit'>(
  type: T,
  payload: CommandPayloads[T],
  options?: { commandId?: string; attempts?: number },
) => Promise<CommandResponse<T>>;

export interface PendingIntent {
  canonicalUrl: string;
  recordingKey: string;
  commandId: string;
}

/** Minimal persistence so a reload mid-submit retries the same intent instead of a new one. */
export interface IntentStore {
  load(): PendingIntent | null;
  save(intent: PendingIntent | null): void;
}

export type FlowPhase = 'idle' | 'checking' | 'previewed' | 'submitting' | 'submitted';

export interface FlowState {
  url: string;
  phase: FlowPhase;
  preview: PreviewResult | null;
  /** Last failure; cleared when the link is edited or a new check starts. */
  error: ApiError | null;
  submitted: CommandResult<'request.submit'> | null;
}

const INITIAL: FlowState = { url: '', phase: 'idle', preview: null, error: null, submitted: null };

export class RequestFlow {
  private state: FlowState = INITIAL;
  private listeners = new Set<() => void>();
  /** Bumped by every edit/check so a slow response for an old link is dropped. */
  private generation = 0;
  private intent: PendingIntent | null;
  private inflight: Promise<void> | null = null;
  private readonly send: SendCommand;
  private readonly store: IntentStore | undefined;
  private readonly newId: () => string;

  constructor(send: SendCommand, store?: IntentStore, newId: () => string = () => crypto.randomUUID()) {
    this.send = send;
    this.store = store;
    this.newId = newId;
    this.intent = store?.load() ?? null;
  }

  get snapshot(): FlowState {
    return this.state;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<FlowState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** The intent saved by an earlier page load, if any (the page may prefill its link). */
  get resumable(): PendingIntent | null {
    return this.intent;
  }

  setUrl(url: string) {
    if (this.state.phase === 'submitting' || url === this.state.url) return;
    this.generation++;
    this.inflight = null; // a pending check is for the old link; the next check must start fresh
    this.set({ url, phase: 'idle', preview: null, error: null, submitted: null });
  }

  /** Clear the form and retry aid. An active submission must finish first. */
  reset() {
    if (this.state.phase === 'submitting') return;
    this.generation++;
    this.inflight = null;
    this.clearIntent();
    this.state = INITIAL;
    for (const listener of this.listeners) listener();
  }

  /** Check what the link means without spending allowance. */
  check(): Promise<void> {
    if (this.inflight) return this.inflight;
    const url = this.state.url.trim();
    if (!url) return Promise.resolve();
    const generation = ++this.generation;
    this.set({ phase: 'checking', preview: null, error: null, submitted: null });
    const run = (async () => {
      // One attempt: previews are cheap to repeat by hand and rate limited server-side.
      const response = await this.send('request.preview', { url }, { attempts: 1 });
      if (generation !== this.generation) return;
      if (response.ok) this.set({ phase: 'previewed', preview: response.result });
      else this.set({ phase: 'idle', error: response.error });
    })().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /**
   * Submit exactly what was previewed. The commandId is bound to (link, recording) and kept
   * until the server gives a final answer, so a double tap, a lost response, or a page reload
   * replays one command instead of spending allowance twice.
   */
  submit(): Promise<void> {
    if (this.inflight) return this.inflight;
    const { preview } = this.state;
    if (!preview || !preview.verdict.accepted || this.state.phase !== 'previewed') return Promise.resolve();
    const { canonicalUrl, recordingKey } = preview.source;
    if (!this.intent || this.intent.canonicalUrl !== canonicalUrl || this.intent.recordingKey !== recordingKey) {
      this.intent = { canonicalUrl, recordingKey, commandId: this.newId() };
      this.store?.save(this.intent);
    }
    const intent = this.intent;
    const generation = this.generation;
    this.set({ phase: 'submitting', error: null });
    const run = (async () => {
      const response = await this.send('request.submit', { url: canonicalUrl, expectRecordingKey: recordingKey }, { commandId: intent.commandId });
      if (response.ok) {
        this.clearIntent();
        this.generation++;
        this.set({ phase: 'submitted', submitted: response.result, preview: null, error: null });
        return;
      }
      // Retryable failures keep the same commandId for the next tap; final answers end the intent.
      if (!response.error.retryable) this.clearIntent();
      if (generation === this.generation) {
        // A guard mismatch means the preview is stale: make the user look again.
        const stale = response.error.code === 'GUARD_MISMATCH';
        this.set({ phase: stale ? 'idle' : 'previewed', error: response.error, preview: stale ? null : this.state.preview });
      }
    })().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private clearIntent() {
    this.intent = null;
    this.store?.save(null);
  }
}

/** sessionStorage-backed store; storage failures (private mode) degrade to no persistence. */
export function sessionIntentStore(key = 'jukebox.pending-submit'): IntentStore {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        const value = parsed as Partial<PendingIntent> | null;
        return value && typeof value.canonicalUrl === 'string' && typeof value.recordingKey === 'string' && typeof value.commandId === 'string'
          ? { canonicalUrl: value.canonicalUrl, recordingKey: value.recordingKey, commandId: value.commandId }
          : null;
      } catch {
        return null;
      }
    },
    save(intent) {
      try {
        if (intent) sessionStorage.setItem(key, JSON.stringify(intent));
        else sessionStorage.removeItem(key);
      } catch {
        // Persistence is a retry aid only; the server is the authority.
      }
    },
  };
}
