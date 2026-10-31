import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { AssetDescriptor, MediaPurpose, ResolvedSource, SourceRef } from '../contract/types.ts';
import { canonicalizeUrl } from '../core/sources.ts';
import { PortError } from '../core/ports.ts';
import type { JobState, MediaPort, SourcePort } from '../core/ports.ts';

type Config = { baseUrl: string; resolveTimeoutMs?: number; requestTimeoutMs?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkerAdapter implements SourcePort, MediaPort {
  private readonly baseUrl: string;
  private readonly resolveTimeoutMs: number;
  private readonly requestTimeoutMs: number;
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
      throw new PortError('SOURCE_UNSUPPORTED', 'Spotify/Apple Music matching is not implemented yet');
    }
    const source = ref.provider === 'fixture' ? `fixture:${ref.itemId}` : ref.canonicalUrl;
    let response: Response, body: any;
    try {
      ({ response, body } = await this.json('/api/resolve', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({source,kind:purpose}) }, this.resolveTimeoutMs));
    } catch (error) {
      throw new PortError('SOURCE_UNAVAILABLE', error instanceof Error ? error.message : 'Worker resolve unavailable', true);
    }
    if (!response.ok) throw this.workerError(body, response.status);
    const artworkUrl = typeof body.thumbnail === 'string' ? body.thumbnail : undefined;
    if (artworkUrl !== undefined) {
      try { const parsed = new URL(artworkUrl); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(); }
      catch { throw new PortError('SOURCE_UNAVAILABLE', 'Worker returned an invalid artwork URL'); }
    }
    return { ref, title:body.title, artist:body.artist ?? null, durationSec:body.duration, recordingKey:body.recordingKey,
      ...(artworkUrl ? { artworkUrl } : {}), selection:{source:body.source} };
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

export async function proxyMedia(baseUrl:string,assetId:string,req:IncomingMessage,res:ServerResponse):Promise<void> {
  if(!UUID.test(assetId)){res.statusCode=400;res.end();return;}
  const method=req.method === 'HEAD'?'HEAD':req.method === 'GET'?'GET':null;
  if(!method){res.statusCode=405;res.setHeader('allow','GET, HEAD');res.end();return;}
  const headers:Record<string,string>={};
  for(const name of ['range','if-range']) { const value=req.headers[name]; if(typeof value==='string') headers[name]=value; }
  const controller=new AbortController();
  const abort=()=>controller.abort();
  req.once('aborted',abort); res.once('close',()=>{if(!res.writableEnded) abort();});
  try {
    const upstream=await fetch(`${baseUrl.replace(/\/$/,'')}/media/${assetId}`,{method,headers,signal:controller.signal});
    res.statusCode=upstream.status;
    for(const name of ['content-type','content-length','content-range','accept-ranges','etag','cache-control','x-content-type-options']) {
      const value=upstream.headers.get(name); if(value!==null) res.setHeader(name,value);
    }
    if(method==='HEAD'||!upstream.body){res.end();return;}
    await new Promise<void>((resolve,reject)=>{
      const stream=Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
      stream.once('error',reject); res.once('error',reject); res.once('finish',resolve); stream.pipe(res);
    });
  } catch(error) {
    if(controller.signal.aborted) return;
    if(!res.headersSent){res.statusCode=502;res.end();}
    else res.destroy(error instanceof Error?error:undefined);
  } finally { req.off('aborted',abort); }
}
