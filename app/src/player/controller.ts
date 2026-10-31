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
  activated: boolean;
  message: string;
}

const WAIT_MS = 8000;
const position = (audio: HTMLAudioElement) => Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

/** One controller per mounted playback frame. Nothing claims or activates on mount. */
export class PlayerController {
  readonly audio: HTMLAudioElement;
  state: PlayerState = { status: 'needs_activation', generation: null, loadId: null, epoch: 0, activated: false, message: 'Claim this display, then activate audio locally.' };
  private device: Device;
  private changed: (state: PlayerState) => void;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private desired: DesiredPlayback | null = null;
  private latestRevision = -1;
  private applied: DesiredPlayback | null = null;
  private previous: PlayerReport['previous'];
  private deadline = 0;
  private wallDeadline = 0;
  private safeStartAt = 0;
  private disposed = false;
  private busy = false;
  private reporting = false;
  private reportAgain = false;
  private claiming = false;
  private terminalSent = false;
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;
  private removers: (() => void)[] = [];
  private cancellation = new AbortController();

  constructor(audio: HTMLAudioElement, device: Device, changed: (state: PlayerState) => void) {
    this.audio = audio;
    this.device = device;
    this.changed = changed;
    this.unsubscribe = subscribeSnapshots((s) => this.snapshot(s), (error) => {
      if (error) this.update({ message: `Connection interrupted: ${error}. Playback stops when the lease expires.` });
    }, device.token);
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
    const wake = () => {
      if (!this.live()) this.halt('Lease expired or lost. Claim and activate this display again.');
    };
    const hide = () => this.dispose();
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pagehide', hide);
    this.removers.push(() => window.removeEventListener('pageshow', wake), () => document.removeEventListener('visibilitychange', wake), () => window.removeEventListener('pagehide', hide));
    this.timer = setInterval(() => {
      if (this.state.generation !== null && !this.live()) this.halt('Playback lease expired. Claim and activate again.');
      if (this.live() && !this.busy) void this.reconcile();
    }, 100);
    this.heartbeat = setInterval(() => void this.report(), POLICY.heartbeatMs);
  }

  private update(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.changed(this.state);
  }

  private live() {
    return !this.disposed && this.state.generation !== null && performance.now() < this.deadline && Date.now() < this.wallDeadline;
  }

  private renew(start: number, wall: number) {
    // Use request START, not receipt: a delayed response can never extend local authority.
    this.deadline = start + POLICY.leaseMs;
    this.wallDeadline = wall + POLICY.leaseMs;
  }

  private halt(message: string) {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    void this.context?.suspend();
    this.cancellation.abort();
    this.cancellation = new AbortController();
    publishAnalyser(null);
    this.update({ generation: null, activated: false, status: 'needs_activation', message });
  }

  async claim(takeover = false) {
    if (this.disposed || this.state.generation !== null || this.claiming) return;
    this.claiming = true;
    const start = performance.now(), wall = Date.now();
    let response;
    try {
      response = await this.bounded(sendCommand('player.claim', { takeover }, { bearer: this.device.token, attempts: 1 }));
    } catch (error) {
      if (!this.disposed) this.update({ message: `Claim could not be confirmed: ${String(error)}. Wait for expiry or explicitly take over this device.` });
      return;
    } finally { this.claiming = false; }
    if (this.disposed) return;
    if (!response.ok) { this.update({ message: response.error.message }); return; }
    this.latestRevision = response.revision;
    this.renew(start, wall);
    // A revoked/fenced tab may be disconnected. Even an ordinary claim can
    // follow revocation, so wait out a full old lease for EVERY new claim.
    // Server-side fencing alone cannot stop a disconnected speaker.
    this.safeStartAt = performance.now() + POLICY.leaseMs;
    this.applied = null;
    this.desired = null;
    this.previous = undefined;
    this.terminalSent = false;
    this.update({ generation: response.result.generation, activated: false, status: 'needs_activation', message: 'Claimed. Activate audio locally; playback waits 15 seconds for any previous lease to expire.' });
    await this.refresh();
  }

  private async refresh() {
    const generation = this.state.generation;
    try {
      const res = await fetch('/api/v1/snapshot', { headers: { authorization: `Bearer ${this.device.token}` }, signal: AbortSignal.timeout(4000) });
      if (this.disposed || generation !== this.state.generation) return;
      if (!res.ok) { this.halt('Device authorization lost. Pair again.'); return; }
      this.snapshot(await res.json() as Snapshot);
    } catch { /* Lease watchdog remains independent of network waits. */ }
  }

  private snapshot(snapshot: Snapshot) {
    if (this.state.generation === null || this.disposed || snapshot.revision < this.latestRevision) return;
    this.latestRevision = snapshot.revision;
    if (!snapshot.lease || snapshot.lease.deviceId !== this.device.deviceId || snapshot.lease.generation !== this.state.generation || snapshot.lease.expiresAt <= snapshot.serverTime) {
      this.halt('Playback authority moved or expired. This tab is silent.');
      return;
    }
    if (snapshot.desired && this.desired && snapshot.desired.epoch < this.desired.epoch) return;
    this.desired = snapshot.desired ?? null;
    if (!this.desired) { this.audio.pause(); publishAnalyser(null); }
    void this.reconcile();
  }

  async activate() {
    if (!this.live()) return;
    // Create/resume immediately in the local gesture, before any network await.
    if (!this.context) {
      this.context = new AudioContext();
      const source = this.context.createMediaElementSource(this.audio);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      source.connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    try {
      await this.bounded(this.context.resume());
      if (!this.live()) return;
      this.update({ activated: true, message: performance.now() < this.safeStartAt
        ? 'Audio activated. Waiting for any previous lease to expire (up to 15 seconds).'
        : 'Audio activated. Browser volume does not change OS/HDMI volume.' });
      await this.reconcile();
    } catch (error) {
      if (this.live()) this.update({ activated: false, status: 'needs_activation', message: String(error) });
    }
  }

  private bounded<T>(promise: Promise<T>): Promise<T> {
    const signal = this.cancellation.signal;
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
    if (!this.live() || this.busy || !this.desired) return;
    const desired = this.desired;
    const generation = this.state.generation;
    if (this.applied?.epoch === desired.epoch && this.state.status === 'needs_activation' && performance.now() < this.safeStartAt) return;
    if (this.applied?.epoch === desired.epoch && (!this.state.activated || this.state.status !== 'needs_activation')) return;
    this.busy = true;
    this.update({ status: 'loading' });
    try {
      const newLoad = this.applied?.loadId !== desired.loadId;
      const seek = newLoad || this.applied?.seekSeq !== desired.seekSeq;
      if (newLoad) {
        this.audio.pause();
        if (this.applied) this.previous = { loadId: this.state.loadId ?? 0, positionSec: position(this.audio) };
        this.terminalSent = false;
        this.update({ loadId: desired.loadId, status: 'loading' });
        await this.mediaEvent('loadedmetadata', () => { this.audio.src = desired.asset.url; this.audio.load(); });
      }
      if (seek) {
        const target = Math.min(desired.startPositionSec, Math.max(0, this.audio.duration - .01));
        if (Math.abs(position(this.audio) - target) > .001) await this.mediaEvent('seeked', () => { this.audio.currentTime = target; });
        if (Math.abs(position(this.audio) - target) > .35) throw new Error('Seek exceeded 350ms tolerance');
      }
      if (!this.live() || generation !== this.state.generation) return;
      this.audio.volume = desired.volume;
      this.applied = desired;
      this.update({ epoch: desired.epoch });
      // Never start an obsolete load or intent after an asynchronous load/seek.
      if (this.desired?.epoch !== desired.epoch) { this.audio.pause(); return; }
      if (!this.state.activated || performance.now() < this.safeStartAt) {
        this.audio.pause();
        this.update({ status: 'needs_activation' });
      } else if (desired.intent === 'paused') {
        this.audio.pause();
        publishAnalyser(null);
        this.update({ status: 'paused' });
      } else {
        await this.bounded(this.audio.play());
        if (!this.live() || this.desired?.epoch !== desired.epoch) { this.audio.pause(); return; }
        publishAnalyser(this.analyser);
        this.update({ status: this.audio.paused ? 'paused' : 'playing', message: 'Audio active. Browser volume does not change OS/HDMI volume.' });
      }
    } catch (error) {
      this.audio.pause();
      if (!this.live() || generation !== this.state.generation) return;
      this.applied = desired;
      const activation = error instanceof DOMException && error.name === 'NotAllowedError';
      this.update({ epoch: desired.epoch, status: activation ? 'needs_activation' : 'error', ...(activation ? { activated: false } : {}), message: String(error) });
    } finally {
      this.busy = false;
      if (this.live()) void this.report();
    }
  }

  private async report() {
    if (!this.live() || this.terminalSent) return;
    if (this.reporting) { this.reportAgain = true; return; }
    this.reporting = true;
    const generation = this.state.generation!;
    const previous = this.previous;
    const status = !this.busy && this.state.activated && !['error', 'needs_activation'].includes(this.state.status)
      ? this.audio.ended ? 'ended' : this.audio.paused ? 'paused' : this.audio.readyState < 3 ? 'buffering' : 'playing'
      : this.state.status;
    const payload: PlayerReport = {
      generation, epoch: this.state.epoch, loadId: this.state.loadId ?? 0,
      status, positionSec: position(this.audio), ...(previous ? { previous } : {}),
      ...(status === 'error' ? { error: this.state.message.slice(0, 300) } : {}),
    };
    const start = performance.now(), wall = Date.now();
    try {
      const response = await this.bounded(sendCommand('player.report', payload, { bearer: this.device.token, attempts: 1 }));
      if (this.disposed || generation !== this.state.generation) return;
      if (!response.ok) {
        if (['STALE_LEASE', 'DEVICE_REVOKED', 'UNAUTHENTICATED'].includes(response.error.code)) this.halt(response.error.message);
        return;
      }
      if (!this.live()) { this.halt('Report arrived after local lease expiry. Claim again.'); return; }
      this.renew(start, wall);
      if (this.previous === previous) this.previous = undefined;
      if (this.applied?.loadId === payload.loadId && this.state.epoch === payload.epoch && ['ended', 'error'].includes(status)) this.terminalSent = true;
      // Position-only reports do not emit SSE revisions; refresh the current desired
      // state after every acknowledgement, including terminal transitions.
      await this.refresh();
    } catch {
      if (this.live()) this.update({ message: 'Report not confirmed. Playback stops when the lease expires.' });
    } finally {
      this.reporting = false;
      if (this.reportAgain) { this.reportAgain = false; void this.report(); }
    }
  }

  dispose() {
    if (this.disposed) return;
    const generation = this.state.generation;
    const finalPosition = position(this.audio);
    this.disposed = true;
    this.audio.pause();
    this.cancellation.abort();
    publishAnalyser(null);
    this.unsubscribe();
    clearInterval(this.timer); clearInterval(this.heartbeat);
    for (const remove of this.removers) remove();
    void this.context?.close();
    if (generation !== null) {
      // Preserve the actual final checkpoint before releasing on refresh. Ordered
      // within one best-effort keepalive request chain; expiry remains the fallback.
      const command = (type: string, payload: unknown) => fetch('/api/v1/commands', {
        method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.device.token}` },
        body: JSON.stringify({ commandId: crypto.randomUUID(), type, payload }),
      });
      const checkpoint = this.applied ? command('player.report', { generation, epoch: this.state.epoch, loadId: this.state.loadId ?? 0, status: this.state.status === 'ended' ? 'ended' : 'paused', positionSec: finalPosition, ...(this.previous ? { previous: this.previous } : {}) }) : Promise.resolve();
      void checkpoint.then(() => command('player.release', { generation })).catch(() => {});
    }
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}
