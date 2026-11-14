import { Fragment, useEffect, useState } from 'react';
import { OrganizerGate } from '../shared/OrganizerGate.tsx';
import { Player } from '../player/Player.tsx';
import type { PlayerState } from '../player/controller.ts';
import type { Snapshot } from '../shared/api.ts';
import { blendTechniques, controls, defaults } from './soundbar.ts';
import type { Settings } from './soundbar.ts';
import { Soundbar } from './Soundbar.tsx';
import '@fontsource/inconsolata/400.css';
import './visual.css';

const STORAGE_KEY = 'jukebox.visual.soundbar.v3';

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const settings: Settings = { ...defaults };
    for (const c of controls) {
      const raw = saved[c.key];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        settings[c.key] = Math.min(c.max, Math.max(c.min, Number((Math.round(raw / c.step) * c.step).toFixed(8))));
      }
    }
    const blend = saved.blendTechnique;
    if (typeof blend === 'number' && blendTechniques.some((mode) => mode.value === blend)) {
      settings.blendTechnique = blend;
    }
    return settings;
  } catch {
    return { ...defaults };
  }
}

function formatSliderOutput(value: number, unit?: string): string {
  return `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ''}`;
}

export function VisualPage() {
  const [silent] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('silent'));
  return (
    <OrganizerGate>
      <VisualLab silent={silent} />
    </OrganizerGate>
  );
}

function VisualLab({ silent }: { silent: boolean }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [dithered, setDithered] = useState(true);
  const [copied, setCopied] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [local, setLocal] = useState<PlayerState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Sliders still work without storage.
    }
  }, [settings]);

  const playing = local?.status === 'playing';
  const statusText = silent
    ? 'Silent layout preview'
    : (error ??
      (playing
        ? 'Live audio'
        : local?.status === 'needs_activation'
          ? 'Firefox autoplay permission required'
          : snapshot?.night?.status === 'open'
            ? 'Paused / waiting for audio'
            : 'Night not started'));

  const update = (patch: Partial<Settings>) => {
    setCopied(false);
    setSettings((prev) => ({ ...prev, ...patch }));
  };

  return (
    <main className="visual-lab">
      <header>
        <div>
          <span className="visual-eyebrow">JUKEBOX / VISUAL LAB</span>
          <h1>Soundbar</h1>
        </div>
        <a href="/admin">Admin ↗</a>
      </header>
      <div className="visual-workspace">
        <section className="visual-stage" aria-label="Stationary mirrored audio spectrum">
          <div className="visual-soundbar-host" style={{ position: 'absolute', inset: 0 }}>
            <Soundbar settings={settings} playing={playing} dithered={dithered} />
          </div>
          <div className="visual-caption" role="status">
            <span data-visual-status>{statusText}</span>
            <span data-visual-track>{snapshot?.nowPlaying?.title ?? ''}</span>
          </div>
        </section>
        <aside className="visual-controls">
          <h2>Tune</h2>
          <button
            type="button"
            className="visual-mode"
            data-dither-toggle
            aria-pressed={!dithered}
            onClick={() => setDithered((value) => !value)}
          >
            {dithered ? 'Show underlying function' : 'Show dithering'}
          </button>
          <h2>Audio response</h2>
          <div data-controls-host>
            {controls.map((c) => (
              <Fragment key={c.key}>
                {c.key === 'negativeSpace' && <h2>Negative field</h2>}
                {c.key === 'blendAmount' && (
                  <>
                    <h2>Layer blending</h2>
                    <label>
                      <span>Technique</span>
                      <select
                        value={settings.blendTechnique}
                        onChange={(event) => update({ blendTechnique: Number(event.target.value) })}
                      >
                        {blendTechniques.map((mode) => (
                          <option key={mode.value} value={mode.value}>
                            {mode.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="visual-blend-hint">
                      {blendTechniques.find((mode) => mode.value === settings.blendTechnique)?.description ?? ''}
                    </p>
                  </>
                )}
                <label hidden={c.key === 'blendSoftness' && settings.blendTechnique !== 2}>
                  <span>
                    {c.label}
                    <output>{formatSliderOutput(settings[c.key], c.unit)}</output>
                  </span>
                  <input
                    type="range"
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    value={settings[c.key]}
                    onChange={(event) => update({ [c.key]: Number(event.target.value) })}
                  />
                </label>
              </Fragment>
            ))}
          </div>
          <div className="visual-actions">
            <button
              type="button"
              data-action="reset"
              onClick={() => {
                setCopied(false);
                setSettings({ ...defaults });
              }}
            >
              Reset
            </button>
            <button
              type="button"
              data-action="copy"
              onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(settings, null, 2));
                    setCopied(true);
                  } catch {
                    setError('Could not copy settings');
                  }
                })();
              }}
            >
              {copied ? 'Copied' : 'Copy settings'}
            </button>
          </div>
          <p>Left → right: bass → treble. Settings save in this browser. Use this page instead of the display tab while tuning audio.</p>
        </aside>
      </div>
      {!silent && <Player onSnapshot={setSnapshot} onError={setError} onState={setLocal} />}
    </main>
  );
}
