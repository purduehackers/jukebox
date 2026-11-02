import test from 'node:test';
import assert from 'node:assert/strict';
import { PhidIdentity, IdentityError } from '../src/adapters/phid.ts';
import { FakeOidc } from './fixtures/fake-oidc.ts';

const config = (base: string, extra: Record<string, unknown> = {}) => ({ idBase: base, clientId: 'test-client', redirectUri: 'http://app.test/callback', stateSecret: '0123456789abcdef0123456789abcdef', ...extra });
async function runLogin(provider: FakeOidc, options: Record<string, unknown> = {}, returnTo = '/queue') {
  const id = new PhidIdentity(config(provider.base, options)); const start = await id.beginLogin(returnTo); const auth = new URL(start.redirectUrl);
  await fetch(auth, { redirect: 'manual' });
  const callback = new URLSearchParams({ code: provider.codes.size ? `c${provider.codes.size - 1}` : 'c0', state: auth.searchParams.get('state')! });
  return { result: await id.completeLogin(callback, start.state), start, auth, id };
}

test('happy path, role filtering and organizer/no-role identities', async (t) => {
  const p = await FakeOidc.start(); t.after(() => p.close());
  p.users.set('next', { sub: 's123', preferred_username: 'purdue-user', roles: ['organizer', 'admin', 9] });
  const { result, auth } = await runLogin(p);
  assert.deepEqual(result.identity, { key: `${p.base}/api/auth#s123`, issuer: `${p.base}/api/auth`, subject: 's123', displayName: 'purdue-user', roles: ['organizer', 'admin'] });
  assert.equal(result.returnTo, '/queue'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  p.users.set('next', { sub: 'plain', name: 'Plain' });
  const second = await runLogin(p); assert.deepEqual(second.result.identity.roles, []); assert.equal(second.result.identity.displayName, 'Plain');
});

test('state signature, expiry, callback mismatch and provider errors', async (t) => {
  const p = await FakeOidc.start(); t.after(() => p.close());
  const id = new PhidIdentity(config(p.base)); const start = await id.beginLogin('/');
  await assert.rejects(id.completeLogin(new URLSearchParams(), `${start.state}x`), (e: IdentityError) => e.code === 'state_invalid');
  const now = Date.now() + 600001; const expired = new PhidIdentity(config(p.base, { now: () => now }));
  await assert.rejects(expired.completeLogin(new URLSearchParams(), start.state), (e: IdentityError) => e.code === 'state_expired');
  await assert.rejects(id.completeLogin(new URLSearchParams({ state: 'wrong', code: 'x' }), start.state), (e: IdentityError) => e.code === 'state_invalid');
  await assert.rejects(id.completeLogin(new URLSearchParams({ error: 'access_denied' }), start.state), (e: IdentityError) => e.code === 'provider_error' && e.message.includes('access_denied'));
});

test('PKCE rejection/code reuse, missing subject and id_token nonce mismatch', async (t) => {
  const p = await FakeOidc.start(); t.after(() => p.close());
  const id = new PhidIdentity(config(p.base)); const start = await id.beginLogin('/'); const params = new URL(start.redirectUrl).searchParams;
  await fetch(new URL(start.redirectUrl), { redirect: 'manual' });
  const code = new URLSearchParams({ code: 'unissued', state: params.get('state')! });
  await assert.rejects(id.completeLogin(code, start.state), (e: IdentityError) => e.code === 'token_exchange_failed');
  const wrongChallenge = new URL(`${p.base}/authorize`); wrongChallenge.search = new URLSearchParams({ redirect_uri: 'http://app.test/callback', client_id: 'test-client', state: params.get('state')!, nonce: params.get('nonce')!, code_challenge: 'wrong', response_type: 'code' }).toString();
  await fetch(wrongChallenge, { redirect: 'manual' });
  await assert.rejects(id.completeLogin(new URLSearchParams({ code: 'c1', state: params.get('state')! }), start.state), (e: IdentityError) => e.code === 'token_exchange_failed');
  await fetch(new URL(start.redirectUrl), { redirect: 'manual' });
  const validCallback = new URLSearchParams({ code: 'c2', state: params.get('state')! });
  await id.completeLogin(validCallback, start.state);
  await assert.rejects(id.completeLogin(validCallback, start.state), (e: IdentityError) => e.code === 'token_exchange_failed');
  p.missingSub = true;
  await assert.rejects(runLogin(p), (e: IdentityError) => e.code === 'claims_invalid'); p.missingSub = false;
  p.nextIdNonce = 'wrong';
  await assert.rejects(runLogin(p), (e: IdentityError) => e.code === 'claims_invalid');
});

test('unsafe return paths become / and discovery retries after failure', async (t) => {
  const p = await FakeOidc.start(); t.after(() => p.close());
  const id = new PhidIdentity(config(p.base));
  const unsafe = await id.beginLogin('//evil.com');
  assert.equal(JSON.parse(Buffer.from(unsafe.state.split('.')[0]!, 'base64url').toString()).returnTo, '/');
  p.discoveryFailure = true; const recovering = new PhidIdentity(config(p.base));
  await assert.rejects(recovering.beginLogin('/'), (e: IdentityError) => e.code === 'discovery_failed');
  p.discoveryFailure = false; assert.ok((await recovering.beginLogin('/')).redirectUrl);
  const start = await recovering.beginLogin('https://evil.com'); const body = JSON.parse(Buffer.from(start.state.split('.')[0]!, 'base64url').toString()); assert.equal(body.returnTo, '/');
});

test('rejects non-https discovery endpoints for non-loopback ID base', async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('openid-configuration')) return new Response(JSON.stringify({ issuer: 'https://id.example/api/auth', authorization_endpoint: 'http://evil.test/auth', token_endpoint: 'https://id.example/token', userinfo_endpoint: 'https://id.example/userinfo' }), { status: 200 });
    throw new Error('unexpected');
  };
  const id = new PhidIdentity(config('https://id.example', { fetch: fakeFetch }));
  await assert.rejects(id.beginLogin('/'), (e: IdentityError) => e.code === 'discovery_failed');
});

test('discovery rejects cross-origin HTTPS endpoints and unsafe return paths', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ issuer: 'https://id.example/api/auth', authorization_endpoint: 'https://evil.example/auth', token_endpoint: 'https://id.example/token', userinfo_endpoint: 'https://id.example/userinfo' }));
  await assert.rejects(new PhidIdentity(config('https://id.example', { fetch: fakeFetch })).beginLogin('/'), (e: IdentityError) => e.code === 'discovery_failed');
  const p = await FakeOidc.start();
  try {
    const start = await new PhidIdentity(config(p.base)).beginLogin('/\\evil.example');
    assert.equal(JSON.parse(Buffer.from(start.state.split('.')[0]!, 'base64url').toString()).returnTo, '/');
  } finally { await p.close(); }
});

test('PH ID CSRF guard rejects Node fetch metadata; back-channel transport completes login', async (t) => {
  const p = await FakeOidc.start(); t.after(() => p.close());
  const browserLike = await fetch(`${p.base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'invalid' }) });
  assert.equal(browserLike.status, 403);
  assert.equal((await browserLike.json() as { error: string }).error, 'invalid_request');
  p.clientSecret = 'secret';
  const { result } = await runLogin(p, { clientSecret: 'secret' });
  assert.equal(result.identity.subject, 'test-user');
});
