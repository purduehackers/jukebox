// Placeholder owned by phase 4C (display) composing the phase-3 player. Replace freely within this directory.
import { Player } from '../player/Player.tsx';
import { useSnapshot } from '../shared/api.ts';

export function DisplayPage() {
  const { snapshot, error } = useSnapshot();
  return (
    <main className="jb-panel">
      <h1>Jukebox</h1>
      <Player />
      <p>{error ? `Disconnected: ${error}` : snapshot ? `Revision ${snapshot.revision} · role ${snapshot.role}` : 'Connecting…'}</p>
    </main>
  );
}
