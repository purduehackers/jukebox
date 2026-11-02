import { useState } from 'react';
import { DEFAULT_TUNING } from './signal.ts';
import type { Tuning } from './signal.ts';

type Key = keyof Tuning;
const GROUPS: [string, Key[]][] = [
  ['View', ['dither', 'guides']],
  ['Edge', ['edgeSoftness']],
  ['Bands', ['bassLowHz', 'bassHighHz', 'trebleHighHz', 'highsLowHz', 'highsHighHz', 'gain', 'highsGain']],
  ['Envelope', ['attack', 'release']],
  ['Shape', ['bassWeight', 'trebleWeight', 'height', 'core']],
  ['Fill', ['fillFloor', 'fillTexture', 'fillScale', 'fillMorph']],
  ['Drift', ['driftAmount', 'driftSpeed', 'driftScale']],
  ['Flow shape', ['wispLength', 'wispWidth', 'wispTaper', 'wispSweep', 'wispCurl', 'wispSpacing', 'wispSpeed']],
  ['Bounce', ['bounceGain', 'bounceAttack', 'bounceDecay', 'bounceAverage', 'bounceScale', 'bounceLift']],
];

function range(key: Key): [number, number, number] {
  if (['dither', 'guides'].includes(key)) return [0, 1, 1];
  if (key === 'wispSweep') return [-0.6, 0.6, 0.01];
  if (key === 'wispSpacing') return [0.15, 3, 0.01];
  if (key.endsWith('Hz')) return [20, 20_000, 10];
  if (/attack|release|Decay|Attack|Average/i.test(key)) return [0.001, 2, 0.001];
  if (key === 'core' || key === 'fillFloor') return [0, 1, 0.01];
  return [0, Math.max(1, DEFAULT_TUNING[key] * 3), 0.01];
}

/** Dev tuning panel, shown with `?tune`. Mutates the live tuning object read every frame. */
export function Tuner({ tuning }: { tuning: Tuning }) {
  const [, redraw] = useState(0);
  const [open, setOpen] = useState(true);
  const set = (key: Key, value: number) => { tuning[key] = value; redraw((n) => n + 1); };
  const changed = (Object.keys(DEFAULT_TUNING) as Key[]).filter((key) => tuning[key] !== DEFAULT_TUNING[key]);
  const query = changed.map((key) => `${key}:${+tuning[key].toFixed(4)}`).join(',');
  const link = `${location.origin}${location.pathname}?tune${query ? `&viz=${query}` : ''}`;
  if (!open) return <button className="display-tuner-toggle" onClick={() => setOpen(true)}>TUNE</button>;
  return <aside className="display-tuner" aria-label="Visualizer tuner">
    <header><strong>VISUALIZER TUNER</strong><button onClick={() => setOpen(false)}>hide</button></header>
    <div className="display-tuner-actions">
      <button onClick={() => { for (const key of changed) tuning[key] = DEFAULT_TUNING[key]; redraw((n) => n + 1); }}>reset all</button>
      <button onClick={() => void navigator.clipboard?.writeText(link)}>copy link</button>
    </div>
    <code>{query || 'defaults'}</code>
    {GROUPS.map(([title, keys]) => <fieldset key={title}><legend>{title}</legend>
      {keys.map((key) => {
        const [min, max, step] = range(key);
        if (step === 1 && max === 1) return <label key={key} className={tuning[key] !== DEFAULT_TUNING[key] ? 'changed' : ''}>
          <span>{key}</span><input type="checkbox" checked={tuning[key] >= 0.5} onChange={(e) => set(key, e.target.checked ? 1 : 0)} /><span />
        </label>;
        return <label key={key} className={tuning[key] !== DEFAULT_TUNING[key] ? 'changed' : ''}>
          <span title="double-click to reset" onDoubleClick={() => set(key, DEFAULT_TUNING[key])}>{key}</span>
          <input type="range" min={min} max={max} step={step} value={tuning[key]} onChange={(e) => set(key, Number(e.target.value))} />
          <input type="number" step={step} value={+tuning[key].toFixed(4)} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set(key, e.target.valueAsNumber)} />
        </label>;
      })}
    </fieldset>)}
  </aside>;
}
