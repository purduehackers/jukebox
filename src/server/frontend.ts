import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const types: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp',
};

/** Serve only the app shell and Vite's flat assets directory, never server files. */
export async function serveFrontend(root: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const shell = /^\/(?:index\.html|admin\/?|queue\/?|display\/?|visual\/?)?$/.test(pathname);
  const asset = /^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname);
  if (!shell && !asset) return false;
  let body: Buffer;
  const file = shell ? 'index.html' : pathname.slice(1);
  try {
    body = await readFile(join(root, file));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
  res.writeHead(200, {
    'content-type': types[file.split('.').at(-1)!] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': shell ? 'no-cache' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
