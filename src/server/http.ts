// HTTP transport for the v1 contract. Role comes only from server-verified credentials:
// a PH ID session cookie (attendee/admin) or a paired-device bearer token (player).
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { Identity } from '../contract/types.ts';
import type { IdentityPort } from '../core/ports.ts';
import type { Actor, JukeboxService } from './service.ts';

export interface HttpOptions {
  service: JukeboxService;
  identity: IdentityPort;
  /** Public origin of this service, e.g. https://jukebox.purduehackers.com. */
  origin: string;
  mediaProxy?: (assetId: string, req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  sessionTtlMs?: number;
}

const SESSION_COOKIE = 'jb_session';
const LOGIN_COOKIE = 'jb_login';
const MAX_BODY = 16 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function cookies(req: http.IncomingMessage) {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return out;
}

function json(res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('Body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createHttpServer(options: HttpOptions): http.Server {
  const { service, identity } = options;
  const origin = new URL(options.origin);
  const secure = origin.protocol === 'https:';
  const ttl = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  const cookie = (name: string, value: string, maxAgeSec: number) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;

  function sessionIdentity(req: http.IncomingMessage): Identity | null {
    const id = cookies(req).get(SESSION_COOKIE);
    if (!id) return null;
    const row = service.db.prepare('select identity, expires_at from sessions where id_hash = ?').get(hash(id)) as
      { identity: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= service.clock.now()) return null;
    return JSON.parse(row.identity) as Identity;
  }

  function actorFor(req: http.IncomingMessage): Actor | 'invalid-device' {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const deviceId = service.authenticateDevice(auth.slice(7));
      if (!deviceId) return 'invalid-device';
      if (service.deviceRequiresOrganizer(deviceId)) {
        const organizer = sessionIdentity(req);
        if (!organizer || !service.isAdmin(organizer)) return 'invalid-device';
      }
      return { kind: 'device', deviceId };
    }
    const user = sessionIdentity(req);
    return user ? { kind: 'user', identity: user } : { kind: 'public' };
  }

  /** Cookie-authenticated mutations must be same-origin JSON (CSRF defence with SameSite=Lax). */
  function sameOrigin(req: http.IncomingMessage) {
    const source = req.headers.origin;
    if (source && source !== origin.origin) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    return (req.headers['content-type'] ?? '').split(';')[0] === 'application/json';
  }

  type Stream = { actor: Actor; req: http.IncomingMessage; res: http.ServerResponse; sent: number };
  const streams = new Set<Stream>();
  // Local indexed SQLite lookups only: never contact PH ID in the update path.
  function authorized(stream: Stream) {
    const current = actorFor(stream.req);
    if (current === 'invalid-device' || JSON.stringify(current) !== JSON.stringify(stream.actor)) {
      streams.delete(stream);
      stream.res.end();
      return false;
    }
    return true;
  }
  let pending: NodeJS.Timeout | null = null;
  const unsubscribe = service.onChange(() => {
    pending ??= setTimeout(() => {
      pending = null;
      for (const stream of streams) pushSnapshot(stream);
    }, 25);
  });
  function pushSnapshot(stream: Stream, heartbeat = false) {
    if (!authorized(stream)) return;
    const snapshot = service.snapshot(stream.actor);
    if (snapshot.revision < stream.sent || (!heartbeat && snapshot.revision === stream.sent)) return;
    stream.sent = snapshot.revision;
    stream.res.write(`id: ${snapshot.revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  }
  const keepAlive = setInterval(() => {
    // Position-only reports keep the revision; refresh observedAt and serverTime too.
    for (const stream of streams) pushSnapshot(stream, true);
  }, 5_000);
  keepAlive.unref();

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', origin);
    const method = req.method ?? 'GET';
    const actor = actorFor(req);
    if (actor === 'invalid-device') return json(res, 401, { error: { code: 'DEVICE_REVOKED', message: 'Unknown or revoked device token', retryable: false } });

    if (method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, revision: service.revision() });
    if (method === 'GET' && url.pathname === '/api/v1/snapshot') return json(res, 200, service.snapshot(actor));
    if (method === 'GET' && url.pathname === '/api/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      // Full role-scoped snapshots, not deltas: (re)connect always delivers current state,
      // and clients keep the highest revision they have seen.
      const stream = { actor, req, res, sent: -1 };
      streams.add(stream);
      res.write('retry: 2000\n\n');
      pushSnapshot(stream);
      req.on('close', () => streams.delete(stream));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/v1/events') {
      if (service.roleOf(actor) !== 'admin') return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Admins only', retryable: false } });
      return json(res, 200, { events: service.events(Number(url.searchParams.get('after') ?? 0) || 0) });
    }
    if (method === 'POST' && url.pathname === '/api/v1/commands') {
      if (actor.kind !== 'device' && !sameOrigin(req)) {
        return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Same-origin JSON required', retryable: false } });
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { ok: false, commandId: null, replayed: false, error: { code: 'BAD_REQUEST', message: 'Small JSON body required', retryable: false } });
      }
      const response = await service.execute(actor, body);
      const status = response.ok ? 200 : ({ UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, BAD_REQUEST: 400, INTERNAL: 500 } as Record<string, number>)[response.error.code] ?? 409;
      return json(res, status, response);
    }
    if (method === 'GET' && url.pathname === '/auth/me') {
      return json(res, 200, { role: service.roleOf(actor), identity: actor.kind === 'user' ? { displayName: actor.identity.displayName, roles: actor.identity.roles } : null });
    }
    if (method === 'GET' && url.pathname === '/auth/login') {
      const start = await identity.beginLogin(url.searchParams.get('returnTo') ?? '/');
      res.writeHead(303, { location: start.redirectUrl, 'set-cookie': cookie(LOGIN_COOKIE, start.state, 600), 'cache-control': 'no-store' });
      return res.end();
    }
    if (method === 'GET' && url.pathname === '/auth/callback') {
      const state = cookies(req).get(LOGIN_COOKIE);
      try {
        if (!state) throw new Error('Missing login state');
        const result = await identity.completeLogin(url.searchParams, state);
        const sessionId = randomBytes(32).toString('base64url');
        service.db.prepare('delete from sessions where expires_at <= ?').run(service.clock.now());
        service.db.prepare('insert into sessions values(?, ?, ?)').run(hash(sessionId), JSON.stringify(result.identity), service.clock.now() + ttl);
        const returnTo = result.returnTo.startsWith('/') && !result.returnTo.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(result.returnTo) ? result.returnTo : '/';
        res.writeHead(303, {
          location: returnTo,
          'set-cookie': [cookie(SESSION_COOKIE, sessionId, Math.floor(ttl / 1000)), cookie(LOGIN_COOKIE, '', 0)],
          'cache-control': 'no-store',
        });
        return res.end();
      } catch (error) {
        return json(res, 401, { error: { code: 'UNAUTHENTICATED', message: `Sign-in failed: ${(error as Error).message}`, retryable: true } });
      }
    }
    if (method === 'POST' && url.pathname === '/auth/logout') {
      if (!sameOrigin(req)) return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Same-origin JSON required', retryable: false } });
      const id = cookies(req).get(SESSION_COOKIE);
      if (id) service.db.prepare('delete from sessions where id_hash = ?').run(hash(id));
      // End affected streams immediately; do not wait for a queue change/heartbeat.
      for (const stream of streams) authorized(stream);
      return json(res, 200, { ok: true }, { 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
    }
    if (method === 'GET' && url.pathname === '/auth/fake' && identity.kind === 'fake') {
      // Local development sign-in only; never enabled with PH ID configured.
      const state = (url.searchParams.get('state') ?? '').replace(/[^a-f0-9-]/g, '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Local fake sign-in</title>
<p>Local development identity (not PH ID).</p>
<form action="/auth/callback"><input type="hidden" name="state" value="${state}">
<label>sub <input name="sub" pattern="[a-z0-9_-]{1,40}" required></label>
<label><input type="checkbox" name="roles" value="organizer"> organizer</label>
<button>Sign in</button></form>`);
    }
    if ((method === 'GET' || method === 'HEAD') && /^\/media\/[0-9a-f-]{36}$/.test(url.pathname)) {
      if (!options.mediaProxy) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'No media worker configured', retryable: false } });
      return options.mediaProxy(url.pathname.slice('/media/'.length), req, res);
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error('[jukebox] http error', error);
      if (!res.headersSent) json(res, 500, { error: { code: 'INTERNAL', message: 'Internal error', retryable: true } });
      else res.destroy();
    });
  });
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    clearInterval(keepAlive);
    if (pending) clearTimeout(pending);
    unsubscribe();
    for (const stream of streams) stream.res.end();
    streams.clear();
    return close(callback);
  }) as typeof server.close;
  return server;
}
