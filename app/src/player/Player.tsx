import { useEffect, useRef, useState } from 'react';
import { PlayerController } from './controller.ts';
import type { PlayerState } from './controller.ts';
import type { Snapshot } from '../shared/api.ts';

/** One connection drives both the native player and display presentation. */
export function Player({ onSnapshot, onError, onState }: { onState?: (state: PlayerState) => void; onSnapshot: (snapshot: Snapshot) => void; onError: (error: string | null) => void }) {
  const [state, setState] = useState<PlayerState | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', restore);
    const player = new PlayerController(audio.current!, (next) => { setState(next); onState?.(next); }, onSnapshot, onError);
    return () => { window.removeEventListener('pageshow', restore); player.dispose(); };
  }, [onSnapshot, onError, onState]);
  return <section className="display-player" aria-label="Display sound" data-testid="player" data-status={state?.status ?? 'paused'}
    data-generation={state?.generation ?? ''} data-load-id={state?.loadId ?? ''} data-epoch={state?.epoch ?? 0}>
    <audio id="jukebox-audio" ref={audio} preload="auto" autoPlay />
    {state?.status === 'needs_activation' && <p className="display-player-notice" role="status">
      Firefox blocked autoplay. Set this site’s Autoplay permission to “Allow Audio and Video”.
    </p>}
    {state?.connection === 'error' && <p className="display-player-notice" role="status">{state.message}</p>}
  </section>;
}
