import { subscribeAnalyser, subscribeVisualGain } from '../shared/audio-tap.ts';
import { subscribeLightningColors } from '../shared/lightning-clock.ts';
import { defaults, drawSoundbar, spectrum, type Settings } from './soundbar.ts';
import './soundbar.css';

export interface SoundbarOptions {
  settings?: Settings;
  active?: boolean;
  dithered?: boolean;
}

export interface SoundbarHandle {
  setSettings: (next: Settings) => void;
  setActive: (next: boolean) => void;
  setDithered: (next: boolean) => void;
  dispose: () => void;
}

/** Consumes the player's analyser; creates no audio element or playback session. */
export function mountSoundbar(container: HTMLElement, options: SoundbarOptions = {}): SoundbarHandle {
  let settings = options.settings ?? defaults;
  let active = options.active ?? true;
  let dithered = options.dithered ?? true;
  let visualGain = 1;
  let analyser: AnalyserNode | null = null;
  let previousFftSize: number | undefined;
  let previousSmoothing: number | undefined;
  let fft: Float32Array<ArrayBuffer> = new Float32Array(0);

  const root = document.createElement('div');
  root.className = 'soundbar';

  const canvas = document.createElement('canvas');
  const updateCanvasLabel = () => {
    canvas.setAttribute(
      'aria-label',
      dithered
        ? 'Audio soundbar with ordered dithering'
        : 'Underlying soundbar function without dithering',
    );
  };
  updateCanvasLabel();
  root.append(canvas);

  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    const alertEl = document.createElement('p');
    alertEl.setAttribute('role', 'alert');
    alertEl.textContent = 'Canvas rendering unavailable';
    root.append(alertEl);
  }

  container.append(root);

  const unsubColors = subscribeLightningColors(({ boltColor, zapColor, sparkColor }) => {
    // Exact gradient from hack-night-dashboard/src/components/dash/clock.tsx.
    root.style.backgroundImage = `linear-gradient(120deg in oklch, ${boltColor}, ${zapColor}, ${sparkColor})`;
  });

  const restoreAnalyser = () => {
    if (analyser && previousFftSize !== undefined && previousSmoothing !== undefined) {
      analyser.fftSize = previousFftSize;
      analyser.smoothingTimeConstant = previousSmoothing;
    }
    previousFftSize = undefined;
    previousSmoothing = undefined;
  };

  const unsubAnalyser = subscribeAnalyser((next) => {
    restoreAnalyser();
    analyser = next;
    if (analyser) {
      previousFftSize = analyser.fftSize;
      previousSmoothing = analyser.smoothingTimeConstant;
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      fft = new Float32Array(analyser.frequencyBinCount);
    } else {
      fft = new Float32Array(0);
    }
  });

  const unsubGain = subscribeVisualGain((next) => {
    visualGain = next;
  });

  let disposed = false;
  let frame = 0;
  let last = 0;
  let values: number[] = [];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const render = (now: number) => {
    if (disposed) return;
    frame = requestAnimationFrame(render);
    if (!context) return;
    if (now - last < (reduced.matches ? 200 : 1000 / 30)) return;
    const dt = Math.min(200, now - (last || now - 33));
    last = now;
    const s = settings;
    let measured = Array<number>(s.bands).fill(0);
    if (analyser?.context.state === 'running' && active) {
      analyser.getFloatFrequencyData(fft);
      measured = spectrum(fft, analyser.context.sampleRate, analyser.fftSize, s);
    }
    if (values.length !== s.bands) values = measured.map(() => 0);
    values = measured.map((value, i) => {
      const previous = values[i]!;
      const ms = value > previous ? s.attack : s.release;
      return previous + (value - previous) * (ms ? 1 - Math.exp(-dt / ms) : 1);
    });
    const cell = s.size;
    const width = Math.max(1, Math.ceil(root.clientWidth / cell));
    const height = Math.max(1, Math.ceil(root.clientHeight / cell));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.style.width = `${width * cell}px`;
    canvas.style.height = `${height * cell}px`;
    drawSoundbar(
      context,
      values.map((value) => value * visualGain),
      width,
      height,
      cell,
      s,
      dithered,
      true,
    );
    root.dataset.peak = Math.max(...values).toFixed(4);
  };

  if (context) {
    frame = requestAnimationFrame(render);
  }

  return {
    setSettings(next) {
      settings = next;
    },
    setActive(next) {
      active = next;
    },
    setDithered(next) {
      dithered = next;
      updateCanvasLabel();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      restoreAnalyser();
      unsubColors();
      unsubAnalyser();
      unsubGain();
      root.remove();
    },
  };
}
