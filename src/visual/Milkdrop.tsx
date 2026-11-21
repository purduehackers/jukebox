import { useEffect, useRef, useState } from 'react';
import type { ButterchurnVisualizer } from 'butterchurn';
import { useAnalyser, useVisualGain } from '../shared/hooks.ts';
import {
  DEFAULT_BLEND_SEC,
  DEFAULT_CYCLE_MS,
  SILENCE_1024,
  computeRenderSize,
  extractButterchurn,
  extractPresetMap,
  pickNextPreset,
  scaleTimeDomainSamples,
  sortedPresetNames,
} from './milkdrop.ts';
import './milkdrop.css';

export interface MilkdropProps {
  playing: boolean;
  preset?: string | null;
  presetNonce?: number;
  trackKey?: string | null;
  cycleMs?: number;
  blendSec?: number;
  onPresetChange?: (presetName: string) => void;
  onPresetsLoaded?: (presetNames: string[]) => void;
}

interface AudioTap {
  analyser: AnalyserNode;
  mix: AnalyserNode;
  left: AnalyserNode;
  right: AnalyserNode;
  splitter: ChannelSplitterNode;
  rawMix: Uint8Array<ArrayBuffer>;
  rawL: Uint8Array<ArrayBuffer>;
  rawR: Uint8Array<ArrayBuffer>;
  scaledMix: Uint8Array<ArrayBuffer>;
  scaledL: Uint8Array<ArrayBuffer>;
  scaledR: Uint8Array<ArrayBuffer>;
}

interface EngineState {
  visualizer: ButterchurnVisualizer;
  presets: Record<string, Record<string, unknown>>;
  names: string[];
  currentPreset: string | null;
  ready: boolean;
}

const SILENCE_LEVELS = {
  timeByteArray: SILENCE_1024,
  timeByteArrayL: SILENCE_1024,
  timeByteArrayR: SILENCE_1024,
};

function supportsWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    // Probe on a detached canvas so the output <canvas> stays free for butterchurn's 2D copy context.
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Consumes the player's analyser; creates no audio element, AudioContext, or mic input. */
export function Milkdrop({
  playing,
  preset = null,
  presetNonce = 0,
  trackKey = null,
  cycleMs = DEFAULT_CYCLE_MS,
  blendSec = DEFAULT_BLEND_SEC,
  onPresetChange,
  onPresetsLoaded,
}: MilkdropProps) {
  const analyser = useAnalyser();
  const visualGain = useVisualGain();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failure, setFailure] = useState(false);

  const playingRef = useRef(playing);
  playingRef.current = playing;
  const visualGainRef = useRef(visualGain);
  visualGainRef.current = visualGain;
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const presetNonceRef = useRef(presetNonce);
  presetNonceRef.current = presetNonce;
  const trackKeyRef = useRef(trackKey);
  trackKeyRef.current = trackKey;
  const cycleMsRef = useRef(cycleMs);
  cycleMsRef.current = cycleMs;
  const blendSecRef = useRef(blendSec);
  blendSecRef.current = blendSec;
  const callbacksRef = useRef({ onPresetChange, onPresetsLoaded });
  callbacksRef.current = { onPresetChange, onPresetsLoaded };

  const tapRef = useRef<AudioTap | null>(null);
  const engineRef = useRef<EngineState | null>(null);
  const loadSeqRef = useRef(0);
  const loadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadPresetRef = useRef<(name: string, blend: number) => Promise<void>>(async () => undefined);
  const syncCycleRef = useRef<() => void>(() => undefined);
  const lastPropsRef = useRef<{ preset: string | null; nonce: number; trackKey: string | null }>({
    preset,
    nonce: presetNonce,
    trackKey,
  });

  useEffect(() => {
    if (!analyser) {
      tapRef.current = null;
      return;
    }
    const ctx = analyser.context;
    const mix = ctx.createAnalyser();
    mix.fftSize = 1024;
    mix.smoothingTimeConstant = 0;

    const left = ctx.createAnalyser();
    left.fftSize = 1024;
    left.smoothingTimeConstant = 0;

    const right = ctx.createAnalyser();
    right.fftSize = 1024;
    right.smoothingTimeConstant = 0;

    const splitter = ctx.createChannelSplitter(2);
    analyser.connect(mix);
    analyser.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);

    tapRef.current = {
      analyser,
      mix,
      left,
      right,
      splitter,
      rawMix: new Uint8Array(1024),
      rawL: new Uint8Array(1024),
      rawR: new Uint8Array(1024),
      scaledMix: new Uint8Array(1024),
      scaledL: new Uint8Array(1024),
      scaledR: new Uint8Array(1024),
    };

    return () => {
      if (tapRef.current?.analyser === analyser) tapRef.current = null;
      try { analyser.disconnect(mix); } catch { /* Already disconnected */ }
      try { analyser.disconnect(splitter); } catch { /* Already disconnected */ }
      try { splitter.disconnect(); } catch { /* Already disconnected */ }
    };
  }, [analyser]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    if (!supportsWebGL2()) {
      setFailure(true);
      return;
    }

    let disposed = false;
    let frameId = 0;
    let lastFrameMs = 0;
    let cycleTimer: number | null = null;
    let visualizer: ButterchurnVisualizer | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let intersectionObserver: IntersectionObserver | null = null;

    const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = reducedQuery.matches;
    let pageHidden = document.hidden;
    let contentSkipped = false;

    const isPaused = () => pageHidden || contentSkipped;

    const clearCycleTimer = () => {
      if (cycleTimer !== null) {
        window.clearInterval(cycleTimer);
        cycleTimer = null;
      }
    };

    const startCycleTimer = () => {
      clearCycleTimer();
      const engine = engineRef.current;
      if (disposed || !engine?.ready) return;
      if (presetRef.current !== null || cycleMsRef.current <= 0 || reducedMotion || isPaused()) return;
      cycleTimer = window.setInterval(() => {
        if (disposed || !engine.ready || presetRef.current !== null || isPaused() || reducedMotion) return;
        const next = pickNextPreset(engine.names, engine.currentPreset);
        if (next) void loadPresetRef.current(next, blendSecRef.current);
      }, cycleMsRef.current);
    };
    syncCycleRef.current = startCycleTimer;

    const stopLoop = () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
        frameId = 0;
      }
    };

    const renderFrame = (nowMs: number) => {
      if (disposed || isPaused()) {
        frameId = 0;
        return;
      }
      frameId = requestAnimationFrame(renderFrame);
      if (reducedMotion && nowMs - lastFrameMs < 100) return;
      lastFrameMs = nowMs;

      const engine = engineRef.current;
      if (!engine?.ready) return;

      const tap = tapRef.current;
      const gain = visualGainRef.current;
      let audioLevels = SILENCE_LEVELS;
      if (tap && tap.analyser.context.state === 'running' && playingRef.current && gain > 0.001) {
        tap.mix.getByteTimeDomainData(tap.rawMix);
        tap.left.getByteTimeDomainData(tap.rawL);
        tap.right.getByteTimeDomainData(tap.rawR);
        scaleTimeDomainSamples(tap.rawMix, tap.scaledMix, gain);
        scaleTimeDomainSamples(tap.rawL, tap.scaledL, gain);
        scaleTimeDomainSamples(tap.rawR, tap.scaledR, gain);
        audioLevels = {
          timeByteArray: tap.scaledMix,
          timeByteArrayL: tap.scaledL,
          timeByteArrayR: tap.scaledR,
        };
      }
      try {
        engine.visualizer.render({ audioLevels });
      } catch {
        // Ignore transient WebGL frame errors if context is tearing down.
      }
    };

    const syncExecution = () => {
      if (disposed) return;
      if (isPaused()) {
        stopLoop();
        clearCycleTimer();
      } else {
        if (engineRef.current?.ready && !frameId) {
          frameId = requestAnimationFrame(renderFrame);
        }
        startCycleTimer();
      }
    };

    const onVisibilityChange = () => {
      pageHidden = document.hidden;
      syncExecution();
    };
    const onReducedMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      syncExecution();
    };
    const onContentVisibilityChange = (event: Event) => {
      contentSkipped = Boolean((event as Event & { skipped?: boolean }).skipped);
      syncExecution();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    reducedQuery.addEventListener('change', onReducedMotionChange);
    // contentvisibilityautostatechange does not bubble in some browsers; bind directly to the host.
    host.addEventListener('contentvisibilityautostatechange', onContentVisibilityChange);
    if (!('contentVisibility' in document.documentElement.style) && typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            contentSkipped = !entry.isIntersecting;
            syncExecution();
          }
        },
        { rootMargin: '200px' },
      );
      intersectionObserver.observe(host);
    }

    const syncSize = () => {
      if (disposed || !visualizer) return;
      const { width, height } = computeRenderSize(
        host.clientWidth || 640,
        host.clientHeight || 360,
        window.devicePixelRatio,
      );
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        visualizer.setRendererSize(width, height, { pixelRatio: 1, textureRatio: 1 });
      }
    };

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(syncSize);
      resizeObserver.observe(host);
    }
    window.addEventListener('resize', syncSize);

    const loadPreset = (name: string, blend: number): Promise<void> => {
      const seq = ++loadSeqRef.current;
      const queued = loadQueueRef.current.then(async () => {
        const engine = engineRef.current;
        if (disposed || !engine || seq !== loadSeqRef.current) return;
        const presetData = engine.presets[name];
        if (!presetData) return;
        try {
          await engine.visualizer.loadPreset(presetData, blend);
          if (disposed || seq !== loadSeqRef.current) return;
          engine.currentPreset = name;
          callbacksRef.current.onPresetChange?.(name);
        } catch (error) {
          console.warn('[jukebox] MilkDrop preset load failed', error);
          if (!engine.ready && !disposed) setFailure(true);
        }
      });
      loadQueueRef.current = queued.catch(() => undefined);
      return queued;
    };
    loadPresetRef.current = loadPreset;

    void (async () => {
      try {
        const [bcMod, presetMod] = await Promise.all([
          import('butterchurn'),
          import('butterchurn-presets/dist/base.min.js'),
        ]);
        if (disposed) return;

        const bc = extractButterchurn(bcMod);
        const presets = extractPresetMap(presetMod);
        const names = sortedPresetNames(presets);
        if (names.length === 0) {
          setFailure(true);
          return;
        }

        const { width, height } = computeRenderSize(
          host.clientWidth || 640,
          host.clientHeight || 360,
          window.devicePixelRatio,
        );
        canvas.width = width;
        canvas.height = height;

        visualizer = bc.createVisualizer(null, canvas, {
          width,
          height,
          pixelRatio: 1,
          textureRatio: 1,
        });
        if (disposed) {
          try { visualizer.loseGLContext(); } catch { /* Ignore */ }
          return;
        }

        const engine: EngineState = {
          visualizer,
          presets,
          names,
          currentPreset: null,
          ready: false,
        };
        engineRef.current = engine;
        callbacksRef.current.onPresetsLoaded?.(names);

        const requested = presetRef.current;
        const initialName = requested && presets[requested] ? requested : pickNextPreset(names, null);
        if (!initialName) {
          setFailure(true);
          return;
        }

        lastPropsRef.current = {
          preset: requested,
          nonce: presetNonceRef.current,
          trackKey: trackKeyRef.current,
        };

        await loadPreset(initialName, 0);
        if (disposed) return;

        engine.ready = true;
        const latestPreset = presetRef.current;
        if (latestPreset && presets[latestPreset] && latestPreset !== initialName) {
          lastPropsRef.current.preset = latestPreset;
          await loadPreset(latestPreset, blendSecRef.current);
          if (disposed) return;
        }

        syncExecution();
      } catch (error) {
        console.warn('[jukebox] MilkDrop init failed', error);
        if (!disposed) setFailure(true);
      }
    })();

    return () => {
      disposed = true;
      loadSeqRef.current++;
      stopLoop();
      clearCycleTimer();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener('resize', syncSize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reducedQuery.removeEventListener('change', onReducedMotionChange);
      host.removeEventListener('contentvisibilityautostatechange', onContentVisibilityChange);
      engineRef.current = null;
      loadPresetRef.current = async () => undefined;
      syncCycleRef.current = () => undefined;
      if (visualizer) {
        try { visualizer.loseGLContext(); } catch { /* Ignore */ }
      }
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine?.ready) return;
    const prev = lastPropsRef.current;
    const presetChanged = preset !== prev.preset;
    const nonceChanged = presetNonce !== prev.nonce;
    const trackChanged = trackKey !== prev.trackKey;
    lastPropsRef.current = { preset, nonce: presetNonce, trackKey };

    if (preset !== null && preset !== undefined) {
      if ((presetChanged || nonceChanged) && engine.presets[preset] && preset !== engine.currentPreset) {
        void loadPresetRef.current(preset, blendSecRef.current);
      }
      syncCycleRef.current();
      return;
    }

    if (presetChanged || nonceChanged || (trackChanged && trackKey)) {
      const next = pickNextPreset(engine.names, engine.currentPreset);
      if (next) void loadPresetRef.current(next, blendSecRef.current);
      syncCycleRef.current();
    }
  }, [preset, presetNonce, trackKey]);

  useEffect(() => {
    syncCycleRef.current();
  }, [cycleMs]);

  return (
    <div ref={hostRef} className="milkdrop">
      <canvas ref={canvasRef} aria-label="MilkDrop audio-reactive visualizer" />
      {failure && <p role="alert">WebGL 2 rendering unavailable</p>}
    </div>
  );
}
