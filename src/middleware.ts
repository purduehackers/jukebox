import { defineMiddleware } from 'astro:middleware';
import { getRuntime } from './server/runtime.ts';
import { localOriginRedirect } from './server/local-origin.ts';

export const onRequest = defineMiddleware(async (context, next) => {
  // Hand the per-process authority runtime to every route/page via locals.
  context.locals.runtime = getRuntime();
  const runtime = context.locals.runtime;
  const canonical = localOriginRedirect(context.request.headers.get('host') ?? undefined, context.url.pathname + context.url.search, runtime.origin);
  if (canonical && ['GET', 'HEAD'].includes(context.request.method)) return context.redirect(canonical, 302);
  const path = context.url.pathname.replace(/\/+$/, '');
  if (['/display', '/visual'].includes(path)) {
    const user = runtime.transport.sessionIdentity(context.request);
    if (!user || !runtime.service.isAdmin(user)) {
      // Server-side gate: no player component or script is served to a non-organizer.
      const login = `/auth/login?returnTo=${encodeURIComponent(path)}`;
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jukebox</title><body style="background:#000;color:#fff;font-family:monospace"><main data-testid="organizer-gate"><h1>JUKEBOX</h1><p>Organizer sign-in required</p><a style="color:inherit" href="${login}">Sign in with Purdue Hackers ID</a></main></body></html>`, { status: user ? 403 : 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', vary: 'Cookie' } });
    }
  }
  const response = await next();
  if (!path.startsWith('/_astro/')) response.headers.set('cache-control', 'no-store');
  return response;
});
