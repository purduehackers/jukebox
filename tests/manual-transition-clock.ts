import type { TransitionClock } from '../app/src/player/volume-transition.ts';

export class ManualTransitionClock implements TransitionClock {
  time = 0;
  private sleepers = new Set<{ due: number; done: () => void }>();
  now() { return this.time; }
  wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.sleepers.delete(sleeper); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('cancelled')); };
      const sleeper = { due: this.time + ms, done: () => { cleanup(); resolve(); } };
      this.sleepers.add(sleeper); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const next = Math.min(...[...this.sleepers].map(s => s.due));
      if (next > target) break;
      this.time = next;
      for (const sleeper of [...this.sleepers]) if (sleeper.due <= this.time) sleeper.done();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    this.time = target;
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
}
