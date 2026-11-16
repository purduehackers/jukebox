/** Local volume envelope only. Queue timing and track selection remain authoritative. */
export const TRANSITION_TIMING = { fadeMs: 7000, silenceMs: 3000 };
export interface TransitionClock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
export const transitionClock: TransitionClock = {
  now: () => performance.now(),
  wait(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Volume transition cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  },
};
export interface TransitionOptions {
  clock?: TransitionClock;
  onFactor?: (factor: number) => void;
  timing?: { fadeMs: number; silenceMs: number };
}
export class VolumeTransition {
  readonly clock: TransitionClock;
  readonly timing: typeof TRANSITION_TIMING;
  private base = 1;
  private factor = 1;
  private audio: Pick<HTMLAudioElement, 'volume'>;
  private onFactor: (factor: number) => void;
  constructor(audio: Pick<HTMLAudioElement, 'volume'>, options: TransitionOptions = {}) {
    this.audio = audio;
    this.onFactor = options.onFactor ?? (() => {});
    this.onFactor(1);
    this.clock = options.clock ?? transitionClock;
    this.timing = options.timing ?? TRANSITION_TIMING;
  }
  setVolume(value: number) { this.base = value; this.apply(); }
  setFactor(value: number) { this.factor = value; this.apply(); this.onFactor(value); }
  private apply() { this.audio.volume = Math.max(0, Math.min(1, this.base * this.factor)); }
  async fade(target: number, signal: AbortSignal, continuePlaying = () => true) {
    const initial = this.factor, began = this.clock.now();
    for (;;) {
      signal.throwIfAborted();
      const elapsed = this.clock.now() - began;
      if (elapsed >= this.timing.fadeMs || !continuePlaying()) break;
      this.setFactor(initial + (target - initial) * elapsed / this.timing.fadeMs);
      await this.clock.wait(Math.min(50, this.timing.fadeMs - elapsed), signal);
    }
    signal.throwIfAborted();
    this.setFactor(target);
  }
  async silenceSince(began: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const remaining = this.timing.silenceMs - (this.clock.now() - began);
    if (remaining > 0) await this.clock.wait(remaining, signal);
    signal.throwIfAborted();
  }
}
