import { useEffect, useState } from 'react';
import { requestUrl } from './model.ts';

interface QrResult {
  url: string;
  error: string | null;
}

function computeQr(actualOrigin: string): QrResult {
  try {
    return { url: requestUrl(import.meta.env.VITE_JUKEBOX_PUBLIC_ORIGIN, actualOrigin), error: null };
  } catch (error) {
    return { url: '', error: String(error) };
  }
}

export function RequestQr() {
  // window is unavailable during SSR; compute the real origin after mount.
  const [result, setResult] = useState<QrResult>(() => computeQr('http://localhost'));
  useEffect(() => {
    setResult(computeQr(window.location.origin));
  }, []);
  return (
    <section className="display-request" aria-label="Request a song">
      <div>
        <h2>
          SONG
          <br />
          REQUESTS
        </h2>
        {result.error ? (
          <p role="alert">QR unavailable: invalid request origin</p>
        ) : (
          <a href={result.url}>{result.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>
        )}
      </div>
      {/* Static branded QR for the live https://jukebox.purduehackers.com/queue, served from /qr.png. */}
      {!result.error && (
        <img
          className="display-qr"
          src="/qr.png"
          alt={`Scan to request a song: ${result.url}`}
          width={962}
          height={962}
          decoding="async"
        />
      )}
    </section>
  );
}
