// Boundary between the phase-3 player (publishes) and the 4C visualizer (consumes).
// The player owns the single HTMLAudioElement → MediaElementAudioSourceNode →
// AnalyserNode → destination chain proven in phase 1 and publishes the analyser it
// is currently playing through (null while inactive). The display never creates its
// own audio element, microphone input, or AudioContext for playback.
import { useEffect, useState } from 'react';

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

export function useAnalyser() {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(current);
  useEffect(() => subscribeAnalyser(setAnalyser), []);
  return analyser;
}
