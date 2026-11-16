import type { APIRoute } from 'astro';

// Readiness probe: the authority DB answers and the audio worker is reachable
// with the expected capabilities. (Distinct from /healthz, which only checks
// the web authority.)
export const GET: APIRoute = async ({ locals }) => {
  try {
    locals.runtime.service.db.prepare('select 1').get();
    const response = await fetch(`${process.env.JUKEBOX_WORKER_URL ?? 'http://127.0.0.1:8971'}/api/status`, { signal: AbortSignal.timeout(2000) });
    const worker = await response.json();
    if (!response.ok || worker.capabilities?.candidateSearch !== 1) throw Error('Worker unavailable');
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch { return Response.json({ ok: false }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
};
