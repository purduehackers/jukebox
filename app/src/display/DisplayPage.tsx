// Placeholder owned by phase 4C (display) composing the phase-3 player. Replace freely within this directory.
import { useSnapshot } from '../shared/api.ts';

export function DisplayPage() {
  const { snapshot, error } = useSnapshot();
  return (
    <main className="jb-panel">
      <h1>DisplayPage</h1>
      <p>{error ? `Disconnected: ${error}` : snapshot ? `Revision ${snapshot.revision} · role ${snapshot.role}` : 'Connecting…'}</p>
    </main>
  );
}
