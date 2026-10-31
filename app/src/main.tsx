// Route shell. Ownership: shared/ = integration owner; player/ = phase 3;
// admin/ = 4A; queue/ = 4B; display/ = 4C. /display composes display + player.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminPage } from './admin/AdminPage.tsx';
import { DisplayPage } from './display/DisplayPage.tsx';
import { QueuePage } from './queue/QueuePage.tsx';
import './shared/tokens.css';

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/display') return <DisplayPage />;
  if (path === '/admin') return <AdminPage />;
  if (path === '/queue') return <QueuePage />;
  return (
    <main className="jb-panel">
      <h1>Jukebox</h1>
      <ul>
        <li><a href="/display">/display</a></li>
        <li><a href="/admin">/admin</a></li>
        <li><a href="/queue">/queue</a></li>
      </ul>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
