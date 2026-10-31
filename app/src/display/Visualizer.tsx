import { useEffect, useRef, useState } from 'react';
import { useAnalyser } from '../shared/audio-tap.ts';
import { drawEnvelope, envelopeWindow, measure, smooth } from './signal.ts';
import type { Energy, TimedEnergy } from './signal.ts';

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
    let last = 0, frame = 0, previousMessage = '';
    history.current = [];
    function render(now: number) {
      frame = requestAnimationFrame(render);
      if (now - last < (reduced ? 200 : 1000 / 30)) return;
      const dt = last ? Math.min(0.2, (now - last) / 1000) : 1 / 30; last = now;
      const width = Math.max(1, Math.ceil(target.clientWidth / 2));
      const height = Math.max(1, Math.ceil(target.clientHeight / 2));
      if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
      if (!history.current.length) smoothed = { bass: 0, treble: 0 };
      let energy: Energy = { bass: 0, treble: 0 };
      let label = !playing ? 'Audio paused / waiting' : !analyser ? 'Waiting for local audio' : 'Live audio';
      if (analyser && playing) {
        try {
          analyser.getFloatFrequencyData(frequencies);
          analyser.getFloatTimeDomainData(waveform);
          energy = measure(frequencies, waveform, analyser.context.sampleRate, analyser.fftSize);
          if (analyser.context.state !== 'running') label = 'Audio context suspended';
          else if (energy.bass === 0 && energy.treble === 0) label = 'Silence';
        } catch { label = 'Audio analysis unavailable'; }
      }
      if (label !== previousMessage) { previousMessage = label; setMessage(label); }
      if (!playing || !analyser || label === 'Audio analysis unavailable' || label === 'Audio context suspended') {
        smoothed = { bass: 0, treble: 0 }; history.current = [];
      } else {
        smoothed = { bass: smooth(smoothed.bass, energy.bass, dt), treble: smooth(smoothed.treble, energy.treble, dt) };
      }
      history.current.push({ ...smoothed, time: now });
      while (history.current.length > 1 && history.current[1]!.time < now - 10_000) history.current.shift();
      const samples = reduced ? [smoothed, smoothed] : envelopeWindow(history.current, now);
      drawEnvelope(context!, samples, width, height);
      target.dataset.bass = smoothed.bass.toFixed(4);
      target.dataset.treble = smoothed.treble.toFixed(4);
    }
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [analyser, playing, reduced, trackKey]);
  return <section className="display-visualizer" aria-label="Audio visualizer">
    <canvas ref={canvas} data-testid="visualizer" aria-label="Purple dithered bass and treble envelopes from local playing audio" />
    <span className="display-signal" role="status">{message}{reduced ? ' · reduced motion' : ''}</span>
    <span className="display-legend">BASS ↑ <span>↓ MIDS + HIGHS</span></span>
  </section>;
}
