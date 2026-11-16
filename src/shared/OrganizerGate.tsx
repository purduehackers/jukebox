import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchMe } from './api.ts';

/** Mount no player or display until the server confirms an organizer session. */
export function OrganizerGate({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const me = await fetchMe();
        if (!stopped) { setRole(me.role); setError(false); }
      } catch { if (!stopped) setError(true); }
      finally { busy = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    window.addEventListener('focus', check);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('focus', check); };
  }, []);
  if (role === 'admin') return children;
  return <main className="display-idle" data-testid="organizer-gate">
    <div><h1>JUKEBOX</h1><p>{role ? 'Organizer sign-in required' : error ? 'Could not check sign-in. Reconnecting…' : 'Checking sign-in…'}</p>
      {role && <a href={`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>Sign in with Purdue Hackers ID</a>}
    </div>
  </main>;
}
