import { useEffect, useRef, useState } from 'react';
import { useAnalyser, useLightningColors, useVisualGain } from '../shared/hooks.ts';
import { drawSoundbar, defaults, spectrum } from './soundbar.ts';
import type { Settings } from './soundbar.ts';
import './soundbar.css';

/** Consumes the player's analyser; creates no audio element or playback session. */
export function Soundbar({ settings = defaults, playing, dithered = true }: { settings?: Settings; playing: boolean; dithered?: boolean }) {
  const colors = useLightningColors();
  // Exact gradient from hack-night-dashboard/src/components/dash/clock.tsx.
  const gradient = `linear-gradient(120deg in oklch, ${colors.boltColor}, ${colors.zapColor}, ${colors.sparkColor})`;
  const analyser = useAnalyser();
  const visualGain = useVisualGain();
  const level = useRef(visualGain);
  level.current = visualGain;
  const shape = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failure, setFailure] = useState(false);
  const current = useRef(settings);
  current.current = settings;
  const active = useRef(playing);
  active.current = playing;
  const mode = useRef(dithered);
  mode.current = dithered;

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const context = target.getContext('2d', { alpha: false });
    if (!context) {
      setFailure(true);
      return;
    }
    const previousFftSize = analyser?.fftSize;
    const previousSmoothing = analyser?.smoothingTimeConstant;
    if (analyser) {
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
    }
    let frame = 0;
    let last = 0;
    let values: number[] = [];
    const fft = new Float32Array(analyser?.frequencyBinCount ?? 0);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const render = (nowMs: number) => {
      frame = requestAnimationFrame(render);
      if (nowMs - last < (reduced.matches ? 200 : 1000 / 30)) return;
      const dt = Math.min(200, nowMs - (last || nowMs - 33));
      last = nowMs;
      const s = current.current;
      let measured = Array<number>(s.bands).fill(0);
      if (analyser?.context.state === 'running' && active.current) {
        analyser.getFloatFrequencyData(fft);
        measured = spectrum(fft, analyser.context.sampleRate, analyser.fftSize, s);
      }
      if (values.length !== s.bands) values = measured.map(() => 0);
      values = measured.map((value, i) => {
        const previous = values[i]!;
        const ms = value > previous ? s.attack : s.release;
        return previous + (value - previous) * (ms ? 1 - Math.exp(-dt / ms) : 1);
      });
      if (shape.current) {
        const cell = s.size;
        const width = Math.max(1, Math.ceil(shape.current.clientWidth / cell));
        const height = Math.max(1, Math.ceil(shape.current.clientHeight / cell));
        if (target.width !== width || target.height !== height) {
          target.width = width;
          target.height = height;
        }
        target.style.width = `${width * cell}px`;
        target.style.height = `${height * cell}px`;
        drawSoundbar(context, values.map((value) => value * level.current), width, height, cell, s, mode.current, true);
        shape.current.dataset.peak = Math.max(...values).toFixed(4);
      }
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      if (analyser && previousFftSize !== undefined && previousSmoothing !== undefined) {
        analyser.fftSize = previousFftSize;
        analyser.smoothingTimeConstant = previousSmoothing;
      }
    };
  }, [analyser]);

  return (
    <div ref={shape} className="soundbar" style={{ backgroundImage: gradient }}>
      <canvas
        ref={canvas}
        aria-label={dithered ? 'Audio soundbar with ordered dithering' : 'Underlying soundbar function without dithering'}
      />
      {failure && <p role="alert">Canvas rendering unavailable</p>}
    </div>
  );
}
