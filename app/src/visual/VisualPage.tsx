import { useEffect, useState } from 'react';
import { Player } from '../player/Player.tsx';
import type { PlayerState } from '../player/controller.ts';
import type { Snapshot } from '../shared/api.ts';
import { controls, defaults } from './soundbar.ts';
import type { Settings } from './soundbar.ts';
import { Soundbar } from './Soundbar.tsx';
import '@fontsource/inconsolata/400.css';
import './visual.css';

const storageKey = 'jukebox.visual.soundbar.v3';
function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    const settings = { ...defaults };
    for (const c of controls) if (Number.isFinite(saved[c.key])) settings[c.key] = Math.min(c.max, Math.max(c.min, Number((Math.round(saved[c.key] / c.step) * c.step).toFixed(8))));
    return settings;
  } catch { return { ...defaults }; }
}

export function VisualPage() {
  const [settings, setSettings] = useState(load);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [local, setLocal] = useState<PlayerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dithered, setDithered] = useState(true);
  const silent = new URLSearchParams(location.search).has('silent');
  const playing = local?.status === 'playing';
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Sliders still work without storage. */ } }, [settings]);
  return <main className="visual-lab">
    <header><div><span className="visual-eyebrow">JUKEBOX / VISUAL LAB</span><h1>Soundbar</h1></div><a href="/admin">Admin ↗</a></header>
    <div className="visual-workspace">
      <section className="visual-stage" aria-label="Stationary mirrored audio spectrum">
        <Soundbar settings={settings} playing={playing} dithered={dithered} />
        <div className="visual-caption" role="status"><span>{silent ? 'Silent layout preview' : error ?? (playing ? 'Live audio' : local?.status === 'needs_activation' ? 'Firefox autoplay permission required' : snapshot?.night?.status === 'open' ? 'Paused / waiting for audio' : 'Night not started')}</span><span>{snapshot?.nowPlaying?.title}</span></div>
      </section>
      <aside className="visual-controls"><h2>Tune</h2>
        <button className="visual-mode" aria-pressed={!dithered} onClick={() => setDithered(value => !value)}>{dithered ? 'Show underlying function' : 'Show dithering'}</button>
        <h2>Audio response</h2>
        {controls.map(c => <label key={c.key}><span>{c.label}<output>{Number(settings[c.key].toFixed(2))}{c.unit && ` ${c.unit}`}</output></span><input type="range" min={c.min} max={c.max} step={c.step} value={settings[c.key]} onChange={event => { setCopied(false); setSettings(s => ({ ...s, [c.key]: Number(event.target.value) })); }} /></label>)}
        <div className="visual-actions"><button onClick={() => { setSettings({ ...defaults }); setCopied(false); }}>Reset</button><button onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(settings, null, 2)); setCopied(true); } catch { setError('Could not copy settings'); } }}>{copied ? 'Copied' : 'Copy settings'}</button></div>
        <p>Left → right: bass → treble. Settings save in this browser. Use this page instead of the display tab while tuning audio.</p>
      </aside>
    </div>
    {!silent && <Player onSnapshot={setSnapshot} onError={setError} onState={setLocal} />}
  </main>;
}

