// Minimal proof policy; no queue, identity, or production scheduler lives here.
export const PERIOD_MS = 15 * 60 * 1000;
export function turnDecision({now, periodStarted, role, paused, duration, ended, hasRequest}) {
  if (role === 'request') return ended && !paused ? 'resume-master' : 'wait';
  if (periodStarted === null || now - periodStarted < PERIOD_MS) return ended && !paused ? 'loop-master' : 'wait';
  if (!hasRequest) return ended && !paused ? 'reset-and-loop' : 'empty-reset';
  if (paused) return 'due-paused';
  if (duration > 360 || ended) return 'start-request';
  return 'due-song-end';
}
