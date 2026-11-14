import { useEffect, useRef, useState } from 'react';
import { PlayerController, type PlayerState } from './controller.ts';
import type { Snapshot } from '../../../src/contract/types.ts';

export interface PlayerProps {
  onSnapshot?: (snapshot: Snapshot) => void;
  onState?: (state: PlayerState) => void;
  onError?: (error: string | null) => void;
}

/** One connection drives both the native player and display presentation. */
export function Player({ onSnapshot, onState, onError }: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<PlayerState | null>(null);
  const callbacks = useRef({ onSnapshot, onState, onError });
  callbacks.current = { onSnapshot, onState, onError };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const controller = new PlayerController(
      audio,
      (next) => {
        setState(next);
        callbacks.current.onState?.(next);
      },
      (snapshot) => callbacks.current.onSnapshot?.(snapshot),
      (error) => callbacks.current.onError?.(error),
    );
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pageshow', restore);
      controller.dispose();
    };
  }, []);

  const status = state?.status ?? 'paused';
  const showActivation = status === 'needs_activation';
  const showError = state?.connection === 'error' && !!state.message;

  return (
    <section
      className="display-player"
      aria-label="Display sound"
      data-testid="player"
      data-status={status}
      data-generation={state?.generation !== null && state?.generation !== undefined ? String(state.generation) : ''}
      data-load-id={state?.loadId !== null && state?.loadId !== undefined ? String(state.loadId) : ''}
      data-epoch={String(state?.epoch ?? 0)}
    >
      <audio ref={audioRef} id="jukebox-audio" preload="auto" />
      <p className="display-player-notice" role="status" hidden={!showActivation}>
        Firefox blocked autoplay. Set this site’s Autoplay permission to “Allow Audio and Video”.
      </p>
      <p className="display-player-notice" role="status" hidden={!showError}>
        {showError ? state?.message : ''}
      </p>
    </section>
  );
}
