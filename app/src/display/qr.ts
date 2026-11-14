import qrcode from 'qrcode-generator';
import { escapeHtml } from '../components/ph/html.ts';
import { requestUrl } from './model.ts';

export function qrPath(value: string): { path: string; size: number } {
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (qr.isDark(y, x)) path += `M${x + 4},${y + 4}h1v1h-1z`;
    }
  }
  return { path, size: count + 8 };
}

export function renderRequestQrSection(
  configuredOrigin: string | undefined = import.meta.env.VITE_JUKEBOX_PUBLIC_ORIGIN,
  actualOrigin: string = window.location.origin,
): string {
  let url = '';
  let path = '';
  let size = 0;
  let error: string | null = null;
  try {
    url = requestUrl(configuredOrigin, actualOrigin);
    ({ path, size } = qrPath(url));
  } catch (err) {
    error = String(err);
  }

  return `<section class="display-request" aria-label="Request a song"><div><h2>SONG<br />REQUESTS</h2>${error ? '<p role="alert">QR unavailable: invalid request origin</p>' : `<a href="${escapeHtml(url)}">${escapeHtml(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`}</div>${size > 0 ? `<svg class="display-qr" role="img" aria-label="${escapeHtml(`Scan to request a song: ${url}`)}" data-url="${escapeHtml(url)}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff" /><path d="${path}" fill="#000" /></svg>` : ''}</section>`;
}
