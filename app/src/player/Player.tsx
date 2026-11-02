import { useEffect, useRef, useState } from 'react';
import { PlayerController } from './controller.ts';
import type { PlayerState } from './controller.ts';

/** The display connects itself; the only local control is browser sound permission. */
export function Player() {
  const [state, setState] = useState<PlayerState | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const controller = useRef<PlayerController | null>(null);
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', restore);
    const player = new PlayerController(audio.current!, setState);
    controller.current = player;
    return () => { window.removeEventListener('pageshow', restore); player.dispose(); controller.current = null; };
  }, []);
  const elsewhere = state?.connection === 'elsewhere';
  return <section className="display-player" aria-label="Display sound" data-testid="player" data-status={state?.status ?? 'needs_activation'}
    data-generation={state?.generation ?? ''} data-load-id={state?.loadId ?? ''} data-epoch={state?.epoch ?? 0}>
    <audio id="jukebox-audio" ref={audio} preload="auto" />
    {state && !state.activated && !elsewhere && <div className="display-sound-prompt" role="dialog" aria-labelledby="sound-title">
      <h2 id="sound-title">Enable sound</h2>
      <p>Allow this browser to play the session’s music.</p>
      <button id="player-activate" onClick={() => void controller.current?.activate()}>Enable sound</button>
    </div>}
    {elsewhere && <p className="display-player-notice" role="status">Sound is playing on another display.</p>}
    {state?.connection === 'error' && <p className="display-player-notice" role="status">{state.message}</p>}
  </section>;
}
