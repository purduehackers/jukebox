import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { oidcHttp } from './oidc-http.ts';
import type { Identity } from '../contract/types.ts';
import type { IdentityPort, LoginStart } from '../core/ports.ts';

type Config = { idBase: string; clientId: string; clientSecret?: string; redirectUri: string; stateSecret: string; scopes?: string; fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; timeoutMs?: number; now?: () => number };
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string };
type StatePayload = { state: string; verifier: string; nonce: string; returnTo: string; iat: number };

export class IdentityError extends Error {
  code: 'state_invalid' | 'state_expired' | 'provider_error' | 'token_exchange_failed' | 'userinfo_failed' | 'discovery_failed' | 'claims_invalid';
  constructor(code: IdentityError['code'], message: string) {
    super(message); this.name = 'IdentityError'; this.code = code;
  }
}

/** Identity comes from the provider userinfo endpoint over TLS; the ID token is not used as proof. */
export class PhidIdentity implements IdentityPort {
  readonly kind = 'phid' as const;
  private readonly config: Config;
  private discoveryPromise: Promise<Discovery> | null = null;
  private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  constructor(config: Config) {
    this.config = config;
    if (config.stateSecret.length < 32) throw new Error('stateSecret must be at least 32 characters');
    this.fetcher = config.fetch ?? ((input, init) => oidcHttp(input as string | URL, { method: init?.method, headers: init?.headers, body: init?.body as URLSearchParams | undefined, signal: init?.signal ?? undefined }));
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.now = config.now ?? Date.now;
  }

  async beginLogin(returnTo: string): Promise<LoginStart> {
    const discovery = await this.discovery();
    const payload: StatePayload = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), returnTo: safeReturnTo(returnTo), iat: this.now() };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const state = `${body}.${this.sign(body)}`;
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: this.config.redirectUri, scope: this.config.scopes ?? 'openid profile roles', state: payload.state, nonce: payload.nonce, code_challenge: createHashB64(payload.verifier), code_challenge_method: 'S256' }).toString();
    return { redirectUrl: url.toString(), state };
  }

  async completeLogin(callback: URLSearchParams, state: string): Promise<{ identity: Identity; returnTo: string }> {
    const payload = this.unpack(state);
    if (callback.has('error')) throw new IdentityError('provider_error', `Identity provider error: ${callback.get('error')}`);
    if (callback.get('state') !== payload.state) throw new IdentityError('state_invalid', 'Login state did not match');
    const code = callback.get('code');
    if (!code) throw new IdentityError('claims_invalid', 'Authorization code is missing');
    const discovery = await this.discovery();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: payload.verifier });
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
    if (this.config.clientSecret) headers.set('authorization', `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`);
    else body.set('client_id', this.config.clientId);
    let token: any;
    try {
      const response = await this.fetcher(discovery.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      if (!response.ok) {
        let reason = '';
        try {
          const error = await response.json() as { error?: unknown };
          if (typeof error.error === 'string' && ['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type'].includes(error.error)) reason = ` (${error.error})`;
        } catch { /* Never expose untrusted provider response text. */ }
        throw new IdentityError('token_exchange_failed', `Token exchange failed${reason} [HTTP ${response.status}]`);
      }
      token = await response.json();
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw new IdentityError('token_exchange_failed', 'Token exchange failed (provider unreachable or invalid response)');
    }
    if (typeof token?.access_token !== 'string' || !token.access_token || typeof token?.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') throw new IdentityError('token_exchange_failed', 'Token response was invalid');
    let user: any;
    try {
      const response = await this.fetcher(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      if (!response.ok) throw new Error();
      user = await response.json();
    } catch { throw new IdentityError('userinfo_failed', 'User information request failed'); }
    if (typeof user?.sub !== 'string' || !user.sub.trim()) throw new IdentityError('claims_invalid', 'User information did not contain a subject');
    if (typeof token.id_token === 'string') {
      try {
        const part = token.id_token.split('.')[1]; if (!part) throw new Error();
        const claims = JSON.parse(Buffer.from(part, 'base64url').toString());
        if ((claims.nonce !== undefined && claims.nonce !== payload.nonce) || claims.sub !== user.sub) throw new Error();
      } catch { throw new IdentityError('claims_invalid', 'Identity token claims did not match user information'); }
    }
    const issuer = discovery.issuer;
    const name = [user.preferred_username, user.name, user.sub].find((x) => typeof x === 'string' && x.length > 0) as string;
    const identity: Identity = { key: `${issuer}#${user.sub}`, issuer, subject: user.sub, displayName: name.slice(0, 80), roles: Array.isArray(user.roles) ? user.roles.filter((r: unknown): r is string => typeof r === 'string') : [] };
    return { identity, returnTo: payload.returnTo };
  }

  private unpack(state: string): StatePayload {
    try {
      const [body, signature, extra] = state.split('.');
      if (!body || !signature || extra !== undefined) throw new Error();
      const expected = Buffer.from(this.sign(body)); const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
      const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as StatePayload;
      if (!p.state || !p.verifier || !p.nonce || typeof p.iat !== 'number' || typeof p.returnTo !== 'string') throw new Error();
      if (this.now() - p.iat > 600000 || p.iat > this.now()) throw new IdentityError('state_expired', 'Login state expired');
      return p;
    } catch (e) { if (e instanceof IdentityError) throw e; throw new IdentityError('state_invalid', 'Login state is invalid'); }
  }
  private sign(body: string) { return createHmac('sha256', this.config.stateSecret).update(body).digest('base64url'); }
  private async discovery(): Promise<Discovery> {
    if (!this.discoveryPromise) this.discoveryPromise = this.loadDiscovery().catch((e) => { this.discoveryPromise = null; throw e; });
    return this.discoveryPromise;
  }
  private async loadDiscovery(): Promise<Discovery> {
    try {
      const base = new URL(this.config.idBase); const response = await this.fetcher(new URL('/api/auth/.well-known/openid-configuration', base), { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      if (!response.ok) throw new Error();
      const d = await response.json() as Discovery;
      const loopback = base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
      if ((base.protocol !== 'https:' && !loopback) || d.issuer !== new URL('/api/auth', base).toString()) throw new Error();
      for (const endpoint of [d.authorization_endpoint, d.token_endpoint, d.userinfo_endpoint]) {
        const u = new URL(endpoint);
        if (u.origin !== base.origin || u.username || u.password || u.hash) throw new Error();
      }
      if (!d.authorization_endpoint || !d.token_endpoint || !d.userinfo_endpoint) throw new Error();
      return d;
    } catch { throw new IdentityError('discovery_failed', 'Identity provider discovery failed or was invalid'); }
  }
}

function createHashB64(value: string) { return createHash('sha256').update(value).digest('base64url'); }
function safeReturnTo(value: string) { return value.startsWith('/') && !value.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(value) ? value : '/'; }
export function phidFromEnv(env: Record<string, string | undefined>): PhidIdentity | null {
  const clientId = env.JUKEBOX_PHID_CLIENT_ID; const redirectUri = env.JUKEBOX_PHID_REDIRECT_URI; const stateSecret = env.JUKEBOX_SESSION_SECRET;
  if (!clientId && !redirectUri && !stateSecret && !env.JUKEBOX_PHID_CLIENT_SECRET) return null;
  if (!clientId || !redirectUri || !stateSecret) throw new Error('Incomplete PH ID configuration');
  return new PhidIdentity({ idBase: env.JUKEBOX_PHID_BASE ?? 'https://id.purduehackers.com', clientId, clientSecret: env.JUKEBOX_PHID_CLIENT_SECRET, redirectUri, stateSecret });
}
