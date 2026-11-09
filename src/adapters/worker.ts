import type { AssetDescriptor, MediaPurpose, ResolvedSource, SourceRef } from '../contract/types.ts';
import { canonicalizeUrl } from '../core/sources.ts';
import { PortError } from '../core/ports.ts';
import type { JobState, MediaPort, SourcePort } from '../core/ports.ts';

import { normalizeText, type Candidate, type CandidateSearchPort, type CatalogTrack } from './matching-core.ts';

type Config = { baseUrl: string; resolveTimeoutMs?: number; requestTimeoutMs?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkerAdapter implements SourcePort, MediaPort, CandidateSearchPort {
  private readonly baseUrl: string;
  private readonly resolveTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly metadata = new Map<string, { until: number; value: ResolvedSource }>();
  private readonly searches = new Map<string, { until: number; value: Candidate[] }>();
  constructor(config: Config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.resolveTimeoutMs = config.resolveTimeoutMs ?? 45000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10000;
  }
  canonicalize(url: string): SourceRef { return canonicalizeUrl(url); }

  private async json(path: string, init: RequestInit, timeout: number): Promise<{ response: Response; body: any }> {
    const response = await fetch(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(timeout) });
    let body: any = {};
    try { body = await response.json(); } catch { /* malformed worker response handled by status path */ }
    return { response, body };
  }
  private workerError(body: any, status: number): PortError {
    const message = typeof body?.error === 'string' ? body.error : `Worker request failed (${status})`;
    if (status === 400) {
      if (/duration|six minutes/i.test(message)) return new PortError('DURATION_REJECTED', message);
      return new PortError('SOURCE_UNAVAILABLE', message, false);
    }
    return new PortError('SOURCE_UNAVAILABLE', message, true);
  }
  async resolve(ref: SourceRef, purpose: MediaPurpose): Promise<ResolvedSource> {
    if (ref.provider === 'spotify' || ref.provider === 'apple_music') {
      throw new PortError('SOURCE_UNSUPPORTED', 'Catalog links must use the configured matching source');
    }
    const cacheKey = `${purpose}:${ref.canonicalUrl}`;
    const cached = this.metadata.get(cacheKey);
    if (cached && cached.until > Date.now()) return structuredClone(cached.value);
    const source = ref.provider === 'fixture' ? `fixture:${ref.itemId}` : ref.canonicalUrl;
    let response: Response, body: any;
    try {
      ({ response, body } = await this.json('/api/resolve', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({source,kind:purpose}) }, this.resolveTimeoutMs));
    } catch (error) {
      throw new PortError('SOURCE_UNAVAILABLE', 'The local audio worker is unreachable or timed out. Start scripts/run-local and check --worker / JUKEBOX_WORKER_URL.', true, { kind: 'worker_unavailable' });
    }
    if (!response.ok) {
      const error = this.workerError(body, response.status);
      // This is a selected recording's extraction failure, not a search miss or
      // a worker outage. Recognize the current worker and yt-dlp error wording.
      if (/requested format is not available|did not expose a suitable audio-only format|no verified audio-only source format/i.test(error.message)) {
        error.details = { kind: 'audio_format_unavailable', stage: 'candidate_resolution' };
      }
      throw error;
    }
    if (body.source !== source || typeof body.title !== 'string' || !Number.isFinite(body.duration) || body.duration <= 0 || typeof body.recordingKey !== 'string') throw new PortError('SOURCE_UNAVAILABLE', 'The audio worker returned incomplete recording metadata', true);
    const artworkUrl = typeof body.thumbnail === 'string' ? body.thumbnail : undefined;
    if (artworkUrl !== undefined) {
      try { const parsed = new URL(artworkUrl); if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) throw new Error(); }
      catch { throw new PortError('SOURCE_UNAVAILABLE', 'Worker returned an invalid artwork URL'); }
    }
    const resolved: ResolvedSource = { ref, title:body.title, artist:body.artist ?? null, durationSec:body.duration, recordingKey:body.recordingKey,
      ...(artworkUrl ? { artworkUrl } : {}), selection:{source:body.source} };
    if (this.metadata.size >= 128) this.metadata.delete(this.metadata.keys().next().value!);
    this.metadata.set(cacheKey, { until: Date.now() + 60000, value: resolved });
    return structuredClone(resolved);
  }
  async search(track: CatalogTrack): Promise<Candidate[]> {
    const cacheKey = JSON.stringify([normalizeText(track.title), track.artists.map(normalizeText), track.durationMs]);
    const cached = this.searches.get(cacheKey);
    if (cached && cached.until > Date.now()) return structuredClone(cached.value);
    const query = `${track.artists.join(' ')} ${track.title}`.slice(0, 300).replace(/[\u0000-\u001f]/g, ' ');
    let response: Response, body: any;
    try {
      ({ response, body } = await this.json('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) }, this.resolveTimeoutMs));
    } catch {
      throw new PortError('SOURCE_UNAVAILABLE', 'The local audio worker could not search YouTube. Check worker configuration and connectivity.', true, { kind: 'worker_unavailable' });
    }
    if (response.status === 404) throw new PortError('SOURCE_UNAVAILABLE', 'The audio worker does not support catalog search. Restart scripts/run-local from the current checkout or configure the current worker URL.', false, { kind: 'worker_unavailable' });
    if (!response.ok) throw this.workerError(body, response.status);
    if (!Array.isArray(body.candidates)) throw new PortError('SOURCE_UNAVAILABLE', 'The worker returned invalid search metadata', true);
    const candidates: Candidate[] = body.candidates.slice(0, 10).filter((item: any) => typeof item?.url === 'string' && typeof item.title === 'string' && typeof item.channel === 'string' && Number.isFinite(item.durationSec) && item.durationSec > 0);
    if (this.searches.size >= 128) this.searches.delete(this.searches.keys().next().value!);
    this.searches.set(cacheKey, { until: Date.now() + 60000, value: candidates });
    return structuredClone(candidates);
  }
  async prepare(source: ResolvedSource, purpose: MediaPurpose): Promise<{jobId:string}> {
    const selection = source.selection as {source?:unknown};
    if (typeof selection?.source !== 'string') throw new PortError('SOURCE_UNAVAILABLE','Resolved worker selection is malformed',false);
    try {
      const {response,body} = await this.json('/api/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:selection.source,kind:purpose})},this.requestTimeoutMs);
      if (!response.ok) throw new PortError('SOURCE_UNAVAILABLE',typeof body.error==='string'?body.error:`Worker prepare failed (${response.status})`,body.retryable === true || response.status >= 500);
      return {jobId:body.id};
    } catch(error) {
      if(error instanceof PortError) throw error;
      throw new PortError('SOURCE_UNAVAILABLE',error instanceof Error?error.message:'Worker prepare unavailable',true);
    }
  }
  async job(jobId: string): Promise<JobState> {
    try {
      const {response,body} = await this.json(`/api/jobs/${encodeURIComponent(jobId)}`,{method:'GET'},this.requestTimeoutMs);
      if (!response.ok) return {status:'failed',error:typeof body.error==='string'?body.error:`Worker job lookup failed (${response.status})`,retryable:body.retryable === true || response.status >= 500};
      if (body.status === 'queued' || body.status === 'preparing') return {status:'preparing'};
      if (body.status === 'failed') return {status:'failed',error:body.error ?? 'Media preparation failed',retryable:body.retryable === true};
      if (body.status === 'ready' && body.asset) {
        const a=body.asset;
        // Same-origin path served by proxyMedia: Web Audio analysis needs same-origin media in Firefox.
        const asset:AssetDescriptor={assetId:a.id,url:`/media/${a.id}`,mime:a.mime,codec:a.codec,durationSec:a.duration,byteLength:a.bytes};
        return {status:'ready',asset};
      }
      return {status:'preparing'};
    } catch {
      // A lost poll response says nothing about the worker job; keep polling.
      return {status:'preparing'};
    }
  }
  async retain(revision:number, assetIds:string[]):Promise<void> {
    try {
      const {response,body}=await this.json('/api/retention',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision,assets:assetIds})},this.requestTimeoutMs);
      if(!response.ok) throw new Error(typeof body.error==='string'?body.error:`Worker retention failed (${response.status})`);
    } catch(error) { throw new Error(`Worker retention failed: ${error instanceof Error?error.message:'network error'}`); }
  }
}

/** Stream the worker response without buffering tracks; preserve Firefox seeking. */
export async function proxyMedia(baseUrl: string, assetId: string, req: Request): Promise<Response> {
  if (!UUID.test(assetId)) return new Response(null, { status: 400 });
  if (!['GET', 'HEAD'].includes(req.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const headers = new Headers();
  for (const name of ['range', 'if-range']) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  try {
    const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/media/${assetId}`, { method: req.method, headers, signal: req.signal });
    const out = new Headers();
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'cache-control', 'x-content-type-options']) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    return new Response(req.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
  } catch {
    return new Response(null, { status: 502 });
  }
}
