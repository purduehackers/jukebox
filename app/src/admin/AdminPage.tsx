// Placeholder owned by phase 4A (admin controls). Replace freely within this directory.
import { useSnapshot } from '../shared/api.ts';

export function AdminPage() {
  const { snapshot, error } = useSnapshot();
  return (
    <main className="jb-panel">
      <h1>AdminPage</h1>
      <p>{error ? `Disconnected: ${error}` : snapshot ? `Revision ${snapshot.revision} · role ${snapshot.role}` : 'Connecting…'}</p>
    </main>
  );
}
