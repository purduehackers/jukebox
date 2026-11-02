// OIDC back-channel requests must not send browser Fetch Metadata. Node fetch adds
// Sec-Fetch-Mode even for server calls, which PH ID's browser CSRF guard rejects.
import http from 'node:http';
import https from 'node:https';

export function oidcHttp(input: string | URL, init: { method?: string; headers?: HeadersInit; body?: URLSearchParams; signal?: AbortSignal } = {}): Promise<Response> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) return Promise.reject(new Error('Invalid OIDC protocol'));
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) incoming.destroy(new Error('OIDC response too large'));
        else chunks.push(chunk);
      });
      incoming.on('error', reject);
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else if (value !== undefined) headers.set(key, value);
        }
        const status = incoming.statusCode ?? 500;
        if (status >= 300 && status < 400) return reject(new Error('OIDC redirects are forbidden'));
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    request.on('error', reject);
    request.end(init.body?.toString());
  });
}
