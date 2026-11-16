import { useEffect, useState } from 'react';
import { subscribeSnapshots, type Snapshot } from './api.ts';
import { subscribeAnalyser, subscribeVisualGain } from './audio-tap.ts';
import { subscribeLightningColors, type LightningColors } from './lightning-clock.ts';

/** Live authority snapshots (SSE + reconcile poll) as React state. */
export function useSnapshot() {
  const [state, setState] = useState<{ snapshot: Snapshot | null; error: string | null }>({
    snapshot: null,
    error: null,
  });
  useEffect(
    () =>
      subscribeSnapshots(
        (snapshot) => setState({ snapshot, error: null }),
        (error) => setState((prev) => ({ snapshot: prev.snapshot, error })),
      ),
    [],
  );
  return state;
}

/** The player's current AnalyserNode (null while no playback chain is active). */
export function useAnalyser() {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  useEffect(() => subscribeAnalyser(setAnalyser), []);
  return analyser;
}

export function useVisualGain() {
  const [gain, setGain] = useState(1);
  useEffect(() => subscribeVisualGain(setGain), []);
  return gain;
}

export function useLightningColors() {
  const [colors, setColors] = useState<LightningColors>(() => ({
    boltColor: '#7e3cff',
    zapColor: '#897309',
    sparkColor: '#ef4444',
  }));
  useEffect(() => subscribeLightningColors(setColors), []);
  return colors;
}
