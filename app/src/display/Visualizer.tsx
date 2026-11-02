import { useEffect, useRef, useState } from 'react';
import { useAnalyser } from '../shared/audio-tap.ts';
import { bounceStep, drawEnvelope, envelopeWindow, measure, parseTuning, smooth } from './signal.ts';
import type { Bounce, Energy, TimedEnergy, Tuning } from './signal.ts';
import { Tuner } from './Tuner.tsx';

// One mutable object, read every frame: `?viz=key:value,...` or `window.jukeboxVisualizer`.
const tuning: Tuning = parseTuning(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('viz'));
if (typeof window !== 'undefined') (window as unknown as { jukeboxVisualizer: Tuning }).jukeboxVisualizer = tuning;
const showTuner = typeof location !== 'undefined' && new URLSearchParams(location.search).has('tune');

export function Visualizer({ playing, trackKey, position, observedAt }: {
  playing: boolean; trackKey: string; position: number | null; observedAt: number | null;
}) {
  const analyser = useAnalyser();
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<TimedEnergy[]>([]);
  const [message, setMessage] = useState('Waiting for local audio');
  const [reduced, setReduced] = useState(false);
  const previousReport = useRef<{ position: number; at: number } | null>(null);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { history.current = []; previousReport.current = null; }, [trackKey]);
  useEffect(() => {
    if (position == null || observedAt == null) return;
    const previous = previousReport.current;
    if (previous && Math.abs(position - previous.position - (observedAt - previous.at) / 1000) > 2.5) history.current = [];
    previousReport.current = { position, at: observedAt };
  }, [position, observedAt]);
  useEffect(() => {
    const target = canvas.current!;
    const context = target.getContext('2d', { alpha: false });
    if (!context) { setMessage('Visualizer unavailable: Canvas 2D failed'); return; }
    const frequencies = new Float32Array(analyser?.frequencyBinCount ?? 0);
    const waveform = new Float32Array(analyser?.fftSize ?? 0);
    let smoothed: Energy = { bass: 0, treble: 0 };
    let bounce: Bounce = { average: 0, value: 0 };
    let highs = 0;
    let last = 0, frame = 0, previousMessage = '';
    history.current = [];
    function render(now: number) {
      frame = requestAnimationFrame(render);
      if (now - last < (reduced ? 200 : 1000 / 30)) return;
      const dt = last ? Math.min(0.2, (now - last) / 1000) : 1 / 30; last = now;
      // Two-CSS-pixel cells, snapped to whole device pixels: fractional scaling makes
      // alternating 3/4-pixel cells, which beat against the Bayer pattern as a plaid.
      const ratio = devicePixelRatio || 1, cell = Math.max(1, Math.round(2 * ratio));
      const box = target.parentElement!;
      const width = Math.max(1, Math.ceil(box.clientWidth * ratio / cell));
      const height = Math.max(1, Math.ceil(box.clientHeight * ratio / cell));
      if (target.width !== width || target.height !== height) {
        target.width = width; target.height = height;
        target.style.width = `${width * cell / ratio}px`; target.style.height = `${height * cell / ratio}px`;
      }
      if (!history.current.length) smoothed = { bass: 0, treble: 0 };
      let energy = { bass: 0, treble: 0, highs: 0 };
      let label = !playing ? 'Audio paused / waiting' : !analyser ? 'Waiting for local audio' : 'Live audio';
      if (analyser && playing) {
        try {
          analyser.getFloatFrequencyData(frequencies);
          analyser.getFloatTimeDomainData(waveform);
          energy = measure(frequencies, waveform, analyser.context.sampleRate, analyser.fftSize, tuning);
          if (analyser.context.state !== 'running') label = 'Audio context suspended';
          else if (energy.bass === 0 && energy.treble === 0) label = 'Silence';
        } catch { label = 'Audio analysis unavailable'; }
      }
      if (label !== previousMessage) { previousMessage = label; setMessage(label); }
      if (!playing || !analyser || label === 'Audio analysis unavailable' || label === 'Audio context suspended') {
        smoothed = { bass: 0, treble: 0 }; bounce = { average: 0, value: 0 }; highs = 0; history.current = [];
      } else {
        smoothed = { bass: smooth(smoothed.bass, energy.bass, dt, tuning), treble: smooth(smoothed.treble, energy.treble, dt, tuning) };
        highs = energy.highs;
        bounce = bounceStep(bounce, highs, dt, tuning);
      }
      history.current.push({ ...smoothed, time: now });
      while (history.current.length > 1 && history.current[1]!.time < now - 10_000) history.current.shift();
      const samples = reduced ? [smoothed, smoothed] : envelopeWindow(history.current, now);
      drawEnvelope(context!, samples, width, height, {
        time: reduced ? 0 : now / 1000, historyStart: reduced ? 0 : (now - 10_000) / 1000, historyEnd: reduced ? 0 : now / 1000,
        bounce: reduced ? 0 : bounce.value,
      }, tuning);
      target.dataset.bass = smoothed.bass.toFixed(4);
      target.dataset.treble = smoothed.treble.toFixed(4);
      target.dataset.highs = highs.toFixed(4);
      target.dataset.bounce = bounce.value.toFixed(4);
    }
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [analyser, playing, reduced, trackKey]);
  return <section className="display-visualizer" aria-label="Audio visualizer">
    <canvas ref={canvas} data-testid="visualizer" aria-label="Purple dithered mirrored band from local playing audio, bouncing with the highs" />
    <span className="display-signal" role="status">{message}{reduced ? ' · reduced motion' : ''}</span>
    {showTuner && <Tuner tuning={tuning} />}
    <span className="display-legend">BAND · BASS + MIDS <span>BOUNCE · HIGHS</span></span>
  </section>;
}
