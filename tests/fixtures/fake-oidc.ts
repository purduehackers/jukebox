import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

type User = { sub: string; preferred_username?: string; name?: string; roles?: unknown[] };
type CodeData = { challenge: string; redirect: string; clientId: string; nonce: string; user: User; idNonce?: string };
export class FakeOidc {
  server: Server;
  base = '';
  authorizeParams: URLSearchParams[] = [];
  users = new Map<string, User>();
  codes = new Map<string, CodeData>();
  used = new Set<string>();
  missingSub = false;
  nextIdNonce?: string;
  discoveryFailure = false;
  clientSecret?: string;
  httpEndpoints = false;
  private constructor() {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', this.base);
      const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname.endsWith('openid-configuration')) {
        if (this.discoveryFailure) return send(503, {});
        const proto = this.httpEndpoints ? 'http' : 'http';
        return send(200, { issuer: `${this.base}/api/auth`, authorization_endpoint: `${proto}://${url.host}/authorize`, token_endpoint: `${proto}://${url.host}/token`, userinfo_endpoint: `${proto}://${url.host}/userinfo` });
      }
      if (url.pathname === '/authorize') {
        const p = url.searchParams; this.authorizeParams.push(p);
        const code = `c${this.codes.size}`;
        this.codes.set(code, { challenge: p.get('code_challenge') ?? '', redirect: p.get('redirect_uri') ?? '', clientId: p.get('client_id') ?? '', nonce: p.get('nonce') ?? '', user: this.users.get('next') ?? { sub: 'test-user', preferred_username: 'purdue' }, idNonce: this.nextIdNonce });
        this.users.delete('next'); this.nextIdNonce = undefined;
        res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }); return res.end();
      }
      if (url.pathname === '/token') {
        // Match PH ID's production CSRF guard: back-channel calls omit browser metadata.
        if (req.headers['sec-fetch-mode']) return send(403, { error: 'invalid_request', error_description: 'Cross-site POST form submissions are forbidden' });
        let raw = ''; for await (const chunk of req) raw += chunk;
        const form = new URLSearchParams(raw); const code = form.get('code') ?? ''; const d = this.codes.get(code);
        const expectedBasic = `Basic ${Buffer.from(`test-client:${this.clientSecret}`).toString('base64')}`;
        if (this.clientSecret && req.headers.authorization !== expectedBasic) return send(401, { error: 'invalid_client' });
        const clientId = form.get('client_id') ?? (req.headers.authorization === expectedBasic ? 'test-client' : '');
        if (!d || this.used.has(code) || d.redirect !== form.get('redirect_uri') || d.clientId !== clientId || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== d.challenge) return send(400, { error: 'invalid_grant' });
        this.used.add(code); this.users.set('active', d.user);
        const payload = Buffer.from(JSON.stringify({ nonce: d.idNonce ?? d.nonce, sub: d.user.sub })).toString('base64url');
        return send(200, { access_token: 'offline-token', token_type: 'Bearer', id_token: `e30.${payload}.signature` });
      }
      if (url.pathname === '/userinfo') {
        if (req.headers.authorization !== 'Bearer offline-token') return send(401, {});
        const user = this.users.get('active') ?? { preferred_username: 'nobody', roles: [] };
        return send(200, this.missingSub ? { preferred_username: user.preferred_username, roles: user.roles } : user);
      }
      send(404, {});
    });
  }
  static async start() {
    const f = new FakeOidc(); await new Promise<void>((resolve) => f.server.listen(0, '127.0.0.1', resolve));
    const addr = f.server.address(); if (!addr || typeof addr === 'string') throw new Error('No listener');
    f.base = `http://127.0.0.1:${addr.port}`; return f;
  }
  close() { return new Promise<void>((resolve, reject) => this.server.close((e) => e ? reject(e) : resolve())); }
}
