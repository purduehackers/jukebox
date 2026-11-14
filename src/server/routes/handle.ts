import type { APIRoute } from 'astro';

/**
 * Every injected authority route funnels into the transport's own method+path
 * router. `locals.runtime` is set by src/middleware.ts, which Astro runs before
 * all routes, including injected ones.
 */
export const handle: APIRoute = ({ request, locals }) => locals.runtime.transport.handle(request);
