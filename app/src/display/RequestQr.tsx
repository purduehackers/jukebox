import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { requestUrl } from './model.ts';

export function qrPath(value: string) {
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte'); qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
    if (qr.isDark(y, x)) path += `M${x + 4},${y + 4}h1v1h-1z`;
  }
  return { path, size: count + 8 };
}

export function RequestQr() {
  const result = useMemo(() => {
    try {
      const url = requestUrl(import.meta.env.VITE_JUKEBOX_PUBLIC_ORIGIN, window.location.origin);
      return { url, ...qrPath(url), error: null };
    } catch (error) { return { url: '', path: '', size: 0, error: String(error) }; }
  }, []);
  return <section className="display-request" aria-label="Request a song">
    <div><h2>SONG<br />REQUESTS</h2><p>PH ID · 3 per night</p>
      {result.error ? <p role="alert">QR unavailable: invalid request origin</p> : <a href={result.url}>{result.url.replace(/^https?:\/\//, '')}</a>}
    </div>
    {result.size > 0 && <svg className="display-qr" role="img" aria-label={`Scan to request a song: ${result.url}`} data-url={result.url}
      viewBox={`0 0 ${result.size} ${result.size}`} shapeRendering="crispEdges">
      <rect width={result.size} height={result.size} fill="#fff" /><path d={result.path} fill="#000" />
    </svg>}
  </section>;
}
