import { isAbsolute, resolve } from 'node:path';

/** Fail before opening storage/listeners when deployment configuration is incomplete. */
export function validateProduction(env: NodeJS.ProcessEnv, options: { data: string; devAuth: boolean; fixtures: boolean }) {
  if (env.NODE_ENV !== 'production') return;
  if (options.devAuth || options.fixtures) throw Error('Production refuses fake authentication/media');
  for (const key of ['JUKEBOX_ORIGIN', 'JUKEBOX_PHID_CLIENT_ID', 'JUKEBOX_PHID_CLIENT_SECRET', 'JUKEBOX_PHID_REDIRECT_URI', 'JUKEBOX_SESSION_SECRET']) {
    if (!env[key]) throw Error(`Production requires ${key}`);
  }
  const origin = new URL(env.JUKEBOX_ORIGIN!);
  if (origin.protocol !== 'https:' || origin.origin !== env.JUKEBOX_ORIGIN ||
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw Error('Production JUKEBOX_ORIGIN must be a public HTTPS origin without a trailing slash');
  }
  if (env.JUKEBOX_PHID_REDIRECT_URI !== `${origin.origin}/auth/callback`) throw Error('Production PH ID callback must match JUKEBOX_ORIGIN/auth/callback');
  if (!isAbsolute(options.data)) throw Error('Production requires an absolute persistent service data directory');
  if (env.JUKEBOX_WORKER_DATA && (!isAbsolute(env.JUKEBOX_WORKER_DATA) || resolve(env.JUKEBOX_WORKER_DATA) === resolve(options.data))) {
    throw Error('Worker storage must be an absolute directory distinct from service storage');
  }
  if (env.JUKEBOX_SESSION_SECRET!.length < 32) throw Error('Production session secret must be at least 32 characters');
}
