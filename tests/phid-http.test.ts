import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PhidIdentity } from '../src/adapters/phid.ts';
import { FakeClock, FakeMedia, FakeSource } from '../src/adapters/fakes.ts';
import { JukeboxService } from '../src/server/service.ts';
import { createHttpServer } from '../src/server/http.ts';
import { FakeOidc } from './fixtures/fake-oidc.ts';

test('OIDC sign-in creates a server session, assigns roles, and logout revokes it', async () => {
  const provider = await FakeOidc.start();
  provider.clientSecret = 'secret';
  provider.users.set('next', { sub: 'organizer-1', preferred_username: 'organizer', roles: ['organizer'] });
  const service = new JukeboxService({ dbPath: ':memory:', clock: new FakeClock(), source: new FakeSource(), media: new FakeMedia() });
  const identity = new PhidIdentity({ idBase: provider.base, clientId: 'test-client', clientSecret: 'secret', redirectUri: 'http://127.0.0.1/auth/callback', stateSecret: '0123456789abcdef0123456789abcdef' });
  const server = createHttpServer({ service, identity, origin: 'http://127.0.0.1' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const start = await fetch(`${base}/auth/login?returnTo=/queue`, { redirect: 'manual' });
    const loginCookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const auth = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const callback = new URL(auth.headers.get('location')!);
    const done = await fetch(`${base}${callback.pathname}${callback.search}`, { redirect: 'manual', headers: { cookie: loginCookie } });
    assert.equal(done.status, 303); assert.equal(done.headers.get('location'), '/queue');
    const session = done.headers.getSetCookie().find((c) => c.startsWith('jb_session='))!.split(';')[0]!;
    const me = await (await fetch(`${base}/auth/me`, { headers: { cookie: session } })).json() as any;
    assert.equal(me.role, 'admin'); assert.equal(me.identity.displayName, 'organizer');
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie: session, origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(out.status, 200);
    assert.equal(((await (await fetch(`${base}/auth/me`, { headers: { cookie: session } })).json()) as any).role, 'public');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); service.close(); await provider.close(); }
});
