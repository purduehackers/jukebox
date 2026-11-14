// HTTP transport for the v1 contract. Role comes only from server-verified credentials:
// a PH ID session cookie (attendee/admin) or a paired-device bearer token (player).
import { createHash, randomBytes } from 'node:crypto';
import { metricsResponse } from './metrics.ts';
import type { Identity } from '../contract/types.ts';
import type { IdentityPort } from '../core/ports.ts';
import type { Actor, JukeboxService } from './service.ts';

export interface TransportOptions {
  service: JukeboxService;
  identity: IdentityPort;
  /** Public origin of this service, e.g. https://jukebox.purduehackers.com. */
  origin: string;
  mediaProxy?: (assetId: string, request: Request) => Promise<Response>;
  sessionTtlMs?: number;
}

const SESSION_COOKIE = 'jb_session';
const LOGIN_COOKIE = 'jb_login';
const MAX_BODY = 16 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function cookies(req: Request) {
  const out = new Map<string, string>();
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) { try { out.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())); } catch { /* malformed cookie is not a session */ } }
  }
  return out;
}

function json(status: number, value: unknown, headers: HeadersInit = {}) {
  const out = new Headers(headers);
  out.set('content-type', 'application/json; charset=utf-8');
  out.set('cache-control', 'no-store');
  return new Response(JSON.stringify(value), { status, headers: out });
}

async function readBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw Error('Missing body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw Error('Body too large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export function createTransport(options: TransportOptions) {
  const { service, identity } = options;
  const origin = new URL(options.origin);
  const secure = origin.protocol === 'https:';
  const ttl = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  const cookie = (name: string, value: string, maxAgeSec: number) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;

  function sessionIdentity(req: Request): Identity | null {
    const id = cookies(req).get(SESSION_COOKIE);
    if (!id) return null;
    const row = service.db.prepare('select identity, expires_at from sessions where id_hash = ?').get(hash(id)) as
      { identity: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= service.clock.now()) return null;
    return JSON.parse(row.identity) as Identity;
  }

  function actorFor(req: Request): Actor | 'invalid-device' {
    const auth = req.headers.get('authorization');
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
  function sameOrigin(req: Request) {
    const source = req.headers.get('origin');
    if (source && source !== origin.origin) return false;
    if (req.headers.get('sec-fetch-site') === 'cross-site') return false;
    return (req.headers.get('content-type') ?? '').split(';')[0] === 'application/json';
  }

  type Stream = { actor: Actor; req: Request; controller: ReadableStreamDefaultController<Uint8Array>; sent: number; close: () => void };
  const streams = new Set<Stream>();
  const encoder = new TextEncoder();
  function authorized(stream: Stream) {
    const current = actorFor(stream.req);
    if (current === 'invalid-device' || JSON.stringify(current) !== JSON.stringify(stream.actor)) {
      stream.close();
      return false;
    }
    return true;
  }
  let pending: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = service.onChange(() => {
    pending ??= setTimeout(() => {
      pending = null;
      for (const stream of streams) pushSnapshot(stream);
    }, 25);
  });
  function pushSnapshot(stream: Stream, heartbeat = false) {
    if (!authorized(stream)) return;
    // Bound memory for a client that stops consuming snapshots.
    if ((stream.controller.desiredSize ?? 0) <= 0) { stream.close(); return; }
    const snapshot = service.snapshot(stream.actor);
    if (snapshot.revision < stream.sent || (!heartbeat && snapshot.revision === stream.sent)) return;
    stream.sent = snapshot.revision;
    stream.controller.enqueue(encoder.encode(`id: ${snapshot.revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
  }
  const keepAlive = setInterval(() => {
    for (const stream of streams) pushSnapshot(stream, true);
  }, 5_000);
  keepAlive.unref();

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url ?? '/', origin);
    const method = req.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/metrics') return metricsResponse(service.db);
    const actor = actorFor(req);
    if (actor === 'invalid-device') return json(401, { error: { code: 'DEVICE_REVOKED', message: 'Unknown or revoked device token', retryable: false } });

    if (method === 'GET' && url.pathname === '/healthz') return json(200, { ok: true, revision: service.revision() });
    if (method === 'GET' && url.pathname === '/api/v1/snapshot') return json(200, service.snapshot(actor));
    if (method === 'GET' && url.pathname === '/api/v1/stream') {
      let stream: Stream;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            streams.delete(stream);
            req.signal.removeEventListener('abort', close);
            try { controller.close(); } catch { /* consumer cancelled */ }
          };
          stream = { actor, req, controller, sent: -1, close };
          streams.add(stream);
          req.signal.addEventListener('abort', close, { once: true });
          if (req.signal.aborted) { close(); return; }
          controller.enqueue(encoder.encode('retry: 2000\n\n'));
          pushSnapshot(stream);
        },
        cancel() { stream.close(); },
      }, { highWaterMark: 16 });
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
    }
    if (method === 'GET' && url.pathname === '/api/v1/events') {
      if (service.roleOf(actor) !== 'admin') return json(403, { error: { code: 'FORBIDDEN', message: 'Admins only', retryable: false } });
      return json(200, { events: service.events(Number(url.searchParams.get('after') ?? 0) || 0) });
    }
    if (method === 'POST' && url.pathname === '/api/v1/commands') {
      if (actor.kind !== 'device' && !sameOrigin(req)) {
        return json(403, { error: { code: 'FORBIDDEN', message: 'Same-origin JSON required', retryable: false } });
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        return json(400, { ok: false, commandId: null, replayed: false, error: { code: 'BAD_REQUEST', message: 'Small JSON body required', retryable: false } });
      }
      const response = await service.execute(actor, body);
      const status = response.ok ? 200 : ({ UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, BAD_REQUEST: 400, INTERNAL: 500 } as Record<string, number>)[response.error.code] ?? 409;
      return json(status, response);
    }
    if (method === 'GET' && url.pathname === '/auth/me') {
      return json(200, { role: service.roleOf(actor), identity: actor.kind === 'user' ? { displayName: actor.identity.displayName, roles: actor.identity.roles } : null });
    }
    if (method === 'GET' && url.pathname === '/auth/login') {
      const start = await identity.beginLogin(url.searchParams.get('returnTo') ?? '/');
      return new Response(null, { status: 303, headers: { location: start.redirectUrl, 'set-cookie': cookie(LOGIN_COOKIE, start.state, 600), 'cache-control': 'no-store' } });
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
        const headers = new Headers({ location: returnTo, 'cache-control': 'no-store' });
        headers.append('set-cookie', cookie(SESSION_COOKIE, sessionId, Math.floor(ttl / 1000)));
        headers.append('set-cookie', cookie(LOGIN_COOKIE, '', 0));
        return new Response(null, { status: 303, headers });
      } catch (error) {
        console.warn(JSON.stringify({ event: 'sign_in_failed', code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'login_failed' }));
        return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in again · Jukebox</title><body style="background:#000;color:#fff;font:20px system-ui;max-width:32rem;margin:12vh auto;padding:24px"><h1>Let’s try signing in again</h1><p>Your sign-in link may have expired or already been used. Start a fresh sign-in to continue.</p><p><a style="color:#ffd900" href="/auth/login?returnTo=/queue">Sign in with PH ID</a></p><p><a style="color:#fff" href="/queue">Back to song requests</a></p></body></html>`, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': cookie(LOGIN_COOKIE, '', 0) } });
      }
    }
    if (method === 'POST' && url.pathname === '/auth/logout') {
      if (!sameOrigin(req)) return json(403, { error: { code: 'FORBIDDEN', message: 'Same-origin JSON required', retryable: false } });
      const id = cookies(req).get(SESSION_COOKIE);
      if (id) service.db.prepare('delete from sessions where id_hash = ?').run(hash(id));
      // End affected streams immediately; do not wait for a queue change/heartbeat.
      for (const stream of streams) authorized(stream);
      return json(200, { ok: true }, { 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
    }
    if (method === 'GET' && url.pathname === '/auth/fake' && identity.kind === 'fake') {
      // Local development sign-in only; never enabled with PH ID configured.
      const state = (url.searchParams.get('state') ?? '').replace(/[^a-f0-9-]/g, '');
      return new Response(`<!doctype html><meta charset="utf-8"><title>Local fake sign-in</title>
<p>Local development identity (not PH ID).</p>
<form action="/auth/callback"><input type="hidden" name="state" value="${state}">
<label>sub <input name="sub" pattern="[a-z0-9_-]{1,40}" required></label>
<label><input type="checkbox" name="roles" value="organizer"> organizer</label>
<button>Sign in</button></form>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if ((method === 'GET' || method === 'HEAD') && /^\/media\/[0-9a-f-]{36}$/.test(url.pathname)) {
      if (!options.mediaProxy) return json(404, { error: { code: 'NOT_FOUND', message: 'No media worker configured', retryable: false } });
      return options.mediaProxy(url.pathname.slice('/media/'.length), req);
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
  }

  return {
    sessionIdentity,
    async handle(request: Request): Promise<Response> {
      try { return await route(request); }
      catch (error) {
        console.error('[jukebox] request error', error);
        return json(500, { error: { code: 'INTERNAL', message: 'Internal error', retryable: true } });
      }
    },
    close() {
      clearInterval(keepAlive);
      if (pending) clearTimeout(pending);
      unsubscribe();
      for (const stream of streams) stream.close();
    },
  };
}
