import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createTransport, type TransportOptions } from '../src/server/transport.ts';

export function bridge(handler: (request: Request) => Promise<Response>) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    const request = new Request(new URL(req.url!, 'http://127.0.0.1'), {
      method: req.method, headers: req.headers as Record<string, string>, signal: abort.signal,
      ...(!['GET', 'HEAD'].includes(req.method!) ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: 'half' } : {}),
    });
    try {
      const response = await handler(request);
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(response.headers.getSetCookie().length ? { 'set-cookie': response.headers.getSetCookie() } : {}) });
      if (response.body) await pipeline(Readable.fromWeb(response.body as any), res);
      else res.end();
    } catch { res.destroy(); }
  };
}
export function createHttpServer(options: TransportOptions) {
  const transport = createTransport(options);
  const server = http.createServer(bridge(transport.handle));
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => { transport.close(); return close(callback); }) as typeof server.close;
  return server;
}
