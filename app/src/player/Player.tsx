import { useEffect, useRef, useState } from 'react';
import { sendCommand } from '../shared/api.ts';
import { PlayerController } from './controller.ts';
import type { Device, PlayerState } from './controller.ts';

const STORAGE = 'jukebox.device.v1';
function storedDevice(): Device | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as Device | null;
    return value && typeof value.deviceId === 'string' && typeof value.token === 'string' ? value : null;
  } catch { return null; }
}

/** Phase 4C composes this frame once. Only this component owns venue audio. */
export function Player() {
  const [device, setDevice] = useState(storedDevice);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [state, setState] = useState<PlayerState | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const controller = useRef<PlayerController | null>(null);
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);
  useEffect(() => {
    if (!device || !audio.current) return;
    const player = new PlayerController(audio.current, device, setState);
    controller.current = player;
    return () => { player.dispose(); controller.current = null; };
  }, [device]);
  async function pair() {
    const response = await sendCommand('device.pair', { code: code.trim().toUpperCase() }, { attempts: 1 });
    if (!response.ok) { setMessage(response.error.message); return; }
    try { localStorage.setItem(STORAGE, JSON.stringify(response.result)); }
    catch { setMessage('Device paired for this page only: browser storage is unavailable.'); }
    setDevice(response.result);
    setMessage('');
    setCode('');
  }
  return (
    <section aria-label="Playback device" data-testid="player" data-status={state?.status ?? 'needs_activation'} data-generation={state?.generation ?? ''} data-load-id={state?.loadId ?? ''} data-epoch={state?.epoch ?? 0}>
      <audio key={device?.deviceId ?? 'unpaired'} id="jukebox-audio" ref={audio} preload="auto" />
      <h2>Playback device</h2>
      {!device ? <form onSubmit={(e) => { e.preventDefault(); void pair(); }}>
        <label>Admin pairing code <input id="player-code" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
        <button id="player-pair" type="submit">Pair this browser</button>
      </form> : <>
        <p>Paired browser · {device.deviceId.slice(0, 8)}</p>
        <button onClick={() => {
          controller.current?.dispose();
          try { localStorage.removeItem(STORAGE); } catch { /* Storage can be disabled. */ }
          setDevice(null); setState(null); setMessage('Pairing forgotten on this browser.');
        }}>Forget this browser’s pairing</button>{' '}
        <button id="player-claim" disabled={state?.generation != null} onClick={() => void controller.current?.claim()}>Claim playback</button>{' '}
        <button id="player-takeover" disabled={state?.generation != null} onClick={() => void controller.current?.claim(true)}>Take over this paired device’s other tab</button>{' '}
        <button id="player-activate" disabled={state?.generation == null} onClick={() => void controller.current?.activate()}>Activate audio locally</button>
      </>}
      <p role="status">{message || state?.message || 'Pairing and a local activation are required. This page opens silently.'}</p>
      <p>Playback: {state?.status ?? 'inactive'}. Browser volume is separate from OS/HDMI volume.</p>
    </section>
  );
}
