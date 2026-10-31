// Placeholder owned by phase 4B (attendee queue). Replace freely within this directory.
import { useSnapshot } from '../shared/api.ts';

export function QueuePage() {
  const { snapshot, error } = useSnapshot();
  return (
    <main className="jb-panel">
      <h1>QueuePage</h1>
      <p>{error ? `Disconnected: ${error}` : snapshot ? `Revision ${snapshot.revision} · role ${snapshot.role}` : 'Connecting…'}</p>
    </main>
  );
}
