import { POLICY } from '../../../src/contract/types.ts';
import type { DesiredPlayback, ObservedStatus, PlayerReport, Snapshot } from '../../../src/contract/types.ts';
import { sendCommand, subscribeSnapshots } from '../shared/api.ts';
import { publishAnalyser } from '../shared/audio-tap.ts';

export interface Device { deviceId: string; token: string }
export interface PlayerState {
  status: ObservedStatus;
  generation: number | null;
  loadId: number | null;
  epoch: number;
  positionSec: number | null;
  activated: boolean;
  message: string;
  connection: 'connecting' | 'connected' | 'error';
}

const WAIT_MS = 8000;
const position = (audio: HTMLAudioElement) => Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

// React may reuse a media element during development remounts. It can have only
// one MediaElementAudioSourceNode, so hand its graph to the replacement controller.
const graphs = new WeakMap<HTMLAudioElement, { context: AudioContext; analyser: AnalyserNode; closeTimer?: ReturnType<typeof setTimeout> }>();

/** One native audio player. Connection persists across nights; all playback follows server state. */
export class PlayerController {
  readonly audio: HTMLAudioElement;
  state: PlayerState = { status: 'paused', generation: null, loadId: null, epoch: 0, positionSec: null, activated: false, message: '', connection: 'connecting' };
  private device: Device | null = null;
  private sessionOpen = false;
  private snapshotRevision = -1;
  private snapshotTime = -1;
  private nextConnectAt = 0;
  private secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  private changed: (state: PlayerState) => void;
  private presented: (snapshot: Snapshot) => void;
  private connectionError: (error: string | null) => void;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private resuming: Promise<void> | null = null;
  private desired: DesiredPlayback | null = null;
  private applied: DesiredPlayback | null = null;
  private previous: PlayerReport['previous'];
  private retryPlaybackAt = 0;
  private disposed = false;
  private busy = false;
  private reporting = false;
  private reportAgain = false;
  private claiming = false;
  private terminalSent = false;
  private unsubscribe: () => void = () => {};
  private timer: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;
  private removers: (() => void)[] = [];
  private cancellation = new AbortController();
  private lifetime = new AbortController();

  constructor(audio: HTMLAudioElement, changed: (state: PlayerState) => void, presented: (snapshot: Snapshot) => void = () => {}, connectionError: (error: string | null) => void = () => {}) {
    this.audio = audio;
    this.changed = changed;
    this.presented = presented;
    this.connectionError = connectionError;
    this.subscribe();
    void this.connect();
    queueMicrotask(() => { if (!this.disposed) void this.activate(); });
    for (const name of ['playing', 'pause', 'waiting', 'stalled', 'ended', 'error'] as const) {
      const listener = () => {
        if (!this.live()) { this.audio.pause(); return; }
        if (this.busy || !this.applied || this.terminalSent) return;
        if (name === 'error') this.update({ status: 'error', message: `Audio error ${audio.error?.code}: ${audio.error?.message || 'unavailable media'}` });
        else if (name === 'ended') this.update({ status: 'ended' });
        else if (this.state.activated) this.update({ status: audio.ended ? 'ended' : audio.paused ? 'paused' : audio.readyState < 3 ? 'buffering' : 'playing' });
        void this.report();
      };
      audio.addEventListener(name, listener);
      this.removers.push(() => audio.removeEventListener(name, listener));
    }
    // Native time events update only this page's presentation, not network reports.
    const progress = () => { if (!this.busy && this.applied) this.update({}); };
    audio.addEventListener('timeupdate', progress);
    this.removers.push(() => audio.removeEventListener('timeupdate', progress));
    const wake = () => { this.retryPlaybackAt = 0; void this.activate(); };
    const hide = () => this.dispose();
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    document.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);
    window.addEventListener('pagehide', hide);
    this.removers.push(() => window.removeEventListener('pageshow', wake), () => window.removeEventListener('online', wake),
      () => document.removeEventListener('visibilitychange', wake), () => document.removeEventListener('pointerdown', wake),
      () => document.removeEventListener('keydown', wake), () => window.removeEventListener('pagehide', hide));
    this.timer = setInterval(() => {
      if (this.live() && !this.busy) void this.reconcile();
      if (!this.device && performance.now() >= this.nextConnectAt) void this.connect();
    }, 1000);
    this.heartbeat = setInterval(() => void this.report(), POLICY.heartbeatMs);
  }

  private update(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch, positionSec: position(this.audio) };
    if (!this.disposed) this.changed(this.state);
  }

  private live() {
    return !this.disposed && this.device !== null;
  }

  private stop() {
    this.cancellation.abort();
    this.cancellation = new AbortController();
    this.audio.pause();
    publishAnalyser(null);
    this.desired = null;
    this.applied = null;
    this.update({ status: 'paused', message: '' });
  }

  private disconnect() {
    this.stop();
    this.device = null;
    this.update({ generation: null, connection: 'connecting' });
    this.subscribe();
  }

  private subscribe() {
    this.unsubscribe();
    this.unsubscribe = subscribeSnapshots((s) => this.snapshot(s), (error) => {
      this.connectionError(error);
      if (error === 'HTTP 401' && this.device) this.disconnect();
    }, this.device?.token);
  }

  private async connect() {
    if (this.disposed || this.device || this.claiming) return;
    this.claiming = true;
    this.nextConnectAt = performance.now() + 2000;
    this.update({ connection: 'connecting' });
    try {
      const response = await this.bounded(sendCommand('display.connect', { secret: this.secret }, { attempts: 1 }), this.lifetime.signal);
      if (this.disposed) return;
      if (!response.ok) {
        this.update({ connection: 'error', message: response.error.message });
        return;
      }
      const { deviceId, token, generation } = response.result;
      this.device = { deviceId, token };
      // Ignore any in-flight snapshot from before this successful connection.
      this.snapshotRevision = Math.max(this.snapshotRevision, response.revision);
      this.applied = null;
      this.desired = null;
      this.previous = undefined;
      this.terminalSent = false;
      this.update({ generation, connection: 'connected', message: '' });
      this.subscribe();
      await this.refresh();
    } catch {
      if (!this.disposed) this.update({ connection: 'error', message: 'Could not connect. Retrying…' });
    } finally { this.claiming = false; }
  }

  private async refresh() {
    const device = this.device;
    try {
      const res = await fetch('/api/v1/snapshot', { headers: { authorization: `Bearer ${this.device!.token}` }, signal: AbortSignal.timeout(4000) });
      if (this.disposed || device !== this.device) return;
      if (res.status === 401) { this.disconnect(); return; }
      if (!res.ok) return;
      this.snapshot(await res.json() as Snapshot);
    } catch { /* The snapshot subscription retries automatically. */ }
  }

  private snapshot(snapshot: Snapshot) {
    if (this.disposed) return;
    if (snapshot.revision < this.snapshotRevision || (snapshot.revision === this.snapshotRevision && snapshot.serverTime < this.snapshotTime)) return;
    this.snapshotRevision = snapshot.revision;
    this.snapshotTime = snapshot.serverTime;
    this.sessionOpen = snapshot.night?.status === 'open';
    // Presentation and native audio consume this exact same ordered snapshot.
    // Apply stop/pause before publishing it, including during an in-flight load.
    if (!this.sessionOpen || !snapshot.desired) {
      const hadDesired = this.desired !== null;
      if (hadDesired || this.busy) {
        this.stop();
      }
      if (hadDesired && this.sessionOpen) void this.report();
      this.presented(snapshot);
      return;
    }
    if (!this.device) { this.presented(snapshot); return; }
    if (snapshot.desired && this.desired && snapshot.desired.epoch < this.desired.epoch) return;
    if (this.busy && this.desired && (snapshot.desired.loadId !== this.desired.loadId
      || snapshot.desired.seekSeq !== this.desired.seekSeq || snapshot.desired.intent !== this.desired.intent)) {
      this.cancellation.abort();
      this.cancellation = new AbortController();
    }
    this.desired = snapshot.desired;
    if (snapshot.desired.intent === 'paused') this.audio.pause();
    this.presented(snapshot);
    void this.reconcile();
  }

  async activate() {
    if (this.disposed) return;
    // Create/resume immediately in the local gesture, before any network await.
    try {
      if (!this.context) {
        let graph = graphs.get(this.audio);
        if (!graph) {
          const context = new AudioContext();
          const analyser = context.createAnalyser();
          analyser.fftSize = 2048;
          context.createMediaElementSource(this.audio).connect(analyser);
          analyser.connect(context.destination);
          graph = { context, analyser };
          graphs.set(this.audio, graph);
        }
        clearTimeout(graph.closeTimer);
        this.context = graph.context;
        this.analyser = graph.analyser;
        this.context.onstatechange = () => {
          if (this.context?.state === 'running' && !this.disposed) {
            this.update({ activated: true, message: '' });
            void this.reconcile();
          }
        };
      }
      // Firefox may leave resume pending until a local gesture. Do not turn that
      // permission wait into a media timeout/failure or consume a request allowance.
      void this.resumeContext().then(() => {
        if (this.disposed) return;
        this.update({ activated: this.context?.state === 'running', message: '' });
        void this.reconcile();
      }).catch(() => {
        if (!this.disposed) this.update({ activated: false, status: 'needs_activation' });
      });
      this.update({ activated: this.context.state === 'running' });
      await this.reconcile();
    } catch {
      this.update({ activated: false, status: 'needs_activation', message: 'Firefox blocked autoplay. Allow Audio and Video for this site.' });
    }
  }

  private resumeContext() {
    if (!this.resuming) this.resuming = this.context!.resume().finally(() => { this.resuming = null; });
    return this.resuming;
  }

  private bounded<T>(promise: Promise<T>, signal = this.cancellation.signal): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(value as T);
      };
      const cancel = () => finish(new Error('Playback operation cancelled'));
      const timer = setTimeout(() => finish(new Error('Audio operation timed out')), WAIT_MS);
      signal.addEventListener('abort', cancel, { once: true });
      promise.then((v) => finish(undefined, v), (e) => finish(e));
      if (signal.aborted) cancel();
    });
  }

  private mediaEvent(name: string, action: () => void) {
    let cleanup = () => {};
    const event = new Promise<void>((resolve, reject) => {
      const ok = () => resolve();
      const bad = () => reject(new Error(`Audio error ${this.audio.error?.code}: ${this.audio.error?.message || 'load failed'}`));
      cleanup = () => { this.audio.removeEventListener(name, ok); this.audio.removeEventListener('error', bad); };
      this.audio.addEventListener(name, ok, { once: true });
      this.audio.addEventListener('error', bad, { once: true });
      try { action(); } catch (error) { reject(error); }
    });
    return this.bounded(event).finally(cleanup);
  }

  private async reconcile() {
    if (!this.live() || this.busy || !this.desired || performance.now() < this.retryPlaybackAt) return;
    const desired = this.desired;
    const operation = this.cancellation.signal;
    if (this.applied?.epoch === desired.epoch && this.state.status !== 'needs_activation') return;
    this.busy = true;
    this.update({ status: 'loading' });
    try {
      const newLoad = this.applied?.loadId !== desired.loadId;
      const seek = newLoad || this.applied?.seekSeq !== desired.seekSeq;
      if (newLoad) {
        this.audio.pause();
        if (this.applied && this.state.loadId === this.applied.loadId) {
          this.previous = { loadId: this.applied.loadId, positionSec: position(this.audio) };
        }
        this.terminalSent = false;
        this.update({ loadId: desired.loadId, status: 'loading' });
        await this.mediaEvent('loadedmetadata', () => { this.audio.src = desired.asset.url; this.audio.load(); });
      }
      if (seek) {
        this.terminalSent = false;
        const target = Math.min(desired.startPositionSec, Math.max(0, this.audio.duration - .01));
        if (Math.abs(position(this.audio) - target) > .001) await this.mediaEvent('seeked', () => { this.audio.currentTime = target; });
        if (Math.abs(position(this.audio) - target) > .35) throw new Error('Seek exceeded 350ms tolerance');
      }
      if (!this.live() || operation.aborted) return;
      this.audio.volume = desired.volume;
      this.applied = desired;
      this.update({ epoch: desired.epoch });
      // Never start an obsolete load or intent after an asynchronous load/seek.
      if (this.desired?.epoch !== desired.epoch) { this.audio.pause(); return; }
      if (desired.intent === 'paused') {
        this.audio.pause();
        publishAnalyser(null);
        this.update({ status: 'paused', message: '' });
      } else {
        // Always try native playback. A suspended analyser must not invent an
        // app-level permission gate before Firefox gets to evaluate autoplay.
        void this.resumeContext().catch(() => {});
        await this.bounded(this.audio.play());
        if (!this.live() || operation.aborted || this.desired?.epoch !== desired.epoch) { this.audio.pause(); return; }
        if (this.context?.state !== 'running') throw new DOMException('Firefox blocked audio autoplay', 'NotAllowedError');
        publishAnalyser(this.analyser);
        this.update({ activated: true, status: this.audio.paused ? 'paused' : 'playing', message: '' });
      }
    } catch (error) {
      this.audio.pause();
      if (!this.live() || operation.aborted) return;
      this.applied = desired;
      const activation = error instanceof DOMException && error.name === 'NotAllowedError';
      if (activation) this.retryPlaybackAt = performance.now() + 1000;
      this.update({ epoch: desired.epoch, status: activation ? 'needs_activation' : 'error', ...(activation ? { activated: false } : {}), message: String(error) });
    } finally {
      this.busy = false;
      if (this.live()) void this.report();
      if (this.desired && (operation.aborted || this.desired.epoch !== desired.epoch)) void this.reconcile();
    }
  }

  private async report() {
    // Loading resets the native position before seeking to the checkpoint. That
    // transient zero is not an actual playback checkpoint or acknowledgement.
    if (!this.live() || !this.sessionOpen || this.busy) return;
    if (this.reporting) { this.reportAgain = true; return; }
    this.reporting = true;
    const generation = this.state.generation!;
    const device = this.device!;
    const previous = this.previous;
    // Terminal events are acknowledged once; heartbeats save position and observed health.
    const status = this.terminalSent ? this.state.activated ? 'paused' : 'needs_activation' : !this.busy && this.state.activated && !['error', 'needs_activation'].includes(this.state.status)
      ? this.audio.ended ? 'ended' : this.audio.paused ? 'paused' : this.audio.readyState < 3 ? 'buffering' : 'playing'
      : this.state.status;
    const payload: PlayerReport = {
      generation, epoch: this.state.epoch, loadId: this.state.loadId ?? 0,
      status, positionSec: position(this.audio), ...(previous ? { previous } : {}),
      ...(status === 'error' ? { error: this.state.message.slice(0, 300) } : {}),
    };
    try {
      const response = await this.bounded(sendCommand('player.report', payload, { bearer: this.device!.token, attempts: 1 }), this.lifetime.signal);
      if (this.disposed || device !== this.device) return;
      if (!response.ok) {
        if (['DEVICE_REVOKED', 'UNAUTHENTICATED'].includes(response.error.code)) this.disconnect();
        return;
      }
      if (this.previous === previous) this.previous = undefined;
      if (this.state.loadId === payload.loadId && this.applied?.loadId === payload.loadId && this.state.epoch === payload.epoch && ['ended', 'error'].includes(status)) this.terminalSent = true;
      // Position-only reports do not emit SSE revisions; refresh the current desired
      // state after every acknowledgement, including terminal transitions.
      await this.refresh();
    } catch {
      if (this.live()) this.update({ message: 'Report not confirmed. Reconnecting automatically.' });
    } finally {
      this.reporting = false;
      if (this.reportAgain) { this.reportAgain = false; void this.report(); }
    }
  }

  private release() {
    const generation = this.state.generation;
    const finalPosition = position(this.audio);
    if (generation !== null && this.device) {
      // Save the final checkpoint on refresh. There is no ownership to release.
      const token = this.device.token;
      const command = (type: string, payload: unknown) => fetch('/api/v1/commands', {
        method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ commandId: crypto.randomUUID(), type, payload }),
      });
      const checkpoint = this.applied ? command('player.report', { generation, epoch: this.state.epoch, loadId: this.state.loadId ?? 0, status: this.state.status === 'needs_activation' ? 'needs_activation' : 'paused', positionSec: finalPosition, ...(this.previous ? { previous: this.previous } : {}) }) : Promise.resolve();
      void checkpoint.catch(() => {});
    }
  }

  dispose() {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
    this.audio.pause();
    this.cancellation.abort();
    this.lifetime.abort();
    publishAnalyser(null);
    this.unsubscribe();
    clearInterval(this.timer); clearInterval(this.heartbeat);
    for (const remove of this.removers) remove();
    if (this.context) this.context.onstatechange = null;
    const graph = graphs.get(this.audio);
    if (graph) graph.closeTimer = setTimeout(() => { void graph.context.close(); graphs.delete(this.audio); }, 0);
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}
