// Boundary between the phase-3 player (publishes) and the 4C visualizer (consumes).
// The player owns the single HTMLAudioElement → MediaElementAudioSourceNode →
// AnalyserNode → destination chain proven in phase 1 and publishes the analyser it
// is currently playing through (null while inactive). The display never creates its
// own audio element, microphone input, or AudioContext for playback.
// Shared Web Audio AnalyserNode + gain state between the HTML5 audio player and visualizers.

let current: AnalyserNode | null = null;
const listeners = new Set<(analyser: AnalyserNode | null) => void>();

export function publishAnalyser(analyser: AnalyserNode | null) {
  current = analyser;
  for (const listener of listeners) listener(analyser);
}

export function subscribeAnalyser(listener: (analyser: AnalyserNode | null) => void) {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

// The transition envelope is separate from FFT power, so the visual closes with
// the audible fade even when browser analysis happens before media volume.
let visualGain = 1;
const gainListeners = new Set<(gain: number) => void>();
export function publishVisualGain(gain: number) {
  visualGain = Math.max(0, Math.min(1, gain));
  for (const listener of gainListeners) listener(visualGain);
}
export function subscribeVisualGain(listener: (gain: number) => void): () => void {
  gainListeners.add(listener);
  listener(visualGain);
  return () => { gainListeners.delete(listener); };
}
