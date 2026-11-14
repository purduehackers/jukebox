import { bridge } from './http-server.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WorkerAdapter, proxyMedia } from '../src/adapters/worker.ts';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function worker(handler:(req:any,res:any)=>void) {
  const server=createServer(handler); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address(); if(!address||typeof address==='string') throw Error('bad address');
  return {server,base:`http://127.0.0.1:${address.port}`};
}
test('resolve mapping, duration errors, provider bypass, timeout',async()=>{
  let requests=0;
  const w=await worker((req,res)=>{requests++;let data='';req.on('data',(c:any)=>data+=c);req.on('end',()=>{
    if(req.url==='/api/resolve'&&JSON.parse(data).source==='fixture:request'){res.setHeader('content-type','application/json');res.end(JSON.stringify({source:'fixture:request',title:'request',artist:null,duration:4,recordingKey:'fixture:request',thumbnail:'https://img.example/request.jpg'}));}
    else if(req.url==='/api/resolve'&&JSON.parse(data).source==='fixture:aac'){res.setHeader('content-type','application/json');res.end(JSON.stringify({source:'fixture:aac',title:'request',duration:4,recordingKey:'fixture:aac',thumbnail:'javascript:alert(1)'}));}
    else if(req.url==='/api/resolve'&&JSON.parse(data).source==='fixture:song'){res.statusCode=400;res.end(JSON.stringify({error:'Requests must be strictly under six minutes'}));}
    else if(req.url==='/api/resolve'&&JSON.parse(data).source==='fixture:master'){res.statusCode=503;res.end(JSON.stringify({error:'YouTube did not expose a suitable audio-only format to this worker.'}));}
    else if(req.url==='/api/resolve'){setTimeout(()=>res.end('{}'),100);}
    else {res.statusCode=404;res.end('{}');}
  });});
  try {
    const a=new WorkerAdapter({baseUrl:w.base,resolveTimeoutMs:1000});
    const ref=a.canonicalize('fixture:request'); const resolved=await a.resolve(ref,'request');
    assert.equal(resolved.durationSec,4);assert.deepEqual(resolved.selection,{source:'fixture:request'});assert.equal(resolved.artworkUrl,'https://img.example/request.jpg');
    await assert.rejects(()=>a.resolve(a.canonicalize('fixture:aac'),'request'),(e:any)=>e.code==='SOURCE_UNAVAILABLE');
    await assert.rejects(()=>a.resolve(a.canonicalize('fixture:song'),'request'),(e:any)=>e.code==='DURATION_REJECTED');
    const beforeFormats=requests;
    for(let attempt=0;attempt<2;attempt++) await assert.rejects(()=>a.resolve(a.canonicalize('fixture:master'),'master'),(e:any)=>e.technical && e.details?.kind==='audio_format_unavailable' && e.details?.stage==='candidate_resolution');
    assert.equal(requests,beforeFormats+2,'format failures must not be cached');
    const before=requests;await assert.rejects(()=>a.resolve(a.canonicalize('https://open.spotify.com/track/1234567890123456789012'),'request'),(e:any)=>e.code==='SOURCE_UNSUPPORTED');assert.equal(requests,before);
    await assert.rejects(()=>a.resolve(a.canonicalize('https://www.deezer.com/track/3135556'),'request'),(e:any)=>e.code==='SOURCE_UNSUPPORTED');assert.equal(requests,before);
    await assert.rejects(()=>new WorkerAdapter({baseUrl:w.base,resolveTimeoutMs:20}).resolve(a.canonicalize('https://youtu.be/BaW_jenozKc'),'master'),(e:any)=>e.technical===true);
  } finally {w.server.close();}
});

test('job mapping, transient poll, retention, media proxy range/HEAD/header allowlist',async()=>{
  const w=await worker((req,res)=>{
    if(req.url==='/api/jobs/ready'){res.end(JSON.stringify({status:'ready',asset:{id,url:'/media/'+id,mime:'audio/webm',codec:'opus',duration:4,bytes:20}}));return;}
    if(req.url==='/api/jobs/failed'){res.end(JSON.stringify({status:'failed',error:'bad',retryable:false}));return;}
    if(req.url==='/api/jobs/network'){res.destroy();return;}
    if(req.url==='/api/retention'){let data='';req.on('data',(x:any)=>data+=x);req.on('end',()=>{const b=JSON.parse(data);res.end(JSON.stringify(b));});return;}
    if(req.url==='/media/'+id){res.statusCode=req.method==='HEAD'?200:206;res.setHeader('Content-Type','audio/webm');res.setHeader('Content-Length','0');res.setHeader('Content-Range','bytes 0-0/1');res.setHeader('Accept-Ranges','bytes');res.setHeader('ETag','ok');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Secret','no');res.end();return;}
    res.statusCode=404;res.end();
  });
  try {
    const a=new WorkerAdapter({baseUrl:w.base,requestTimeoutMs:100});
    const ready=await a.job('ready');assert.equal(ready.status,'ready');if(ready.status==='ready'){assert.equal(ready.asset.assetId,id);assert.equal(ready.asset.byteLength,20);}
    const failed=await a.job('failed');assert.deepEqual(failed,{status:'failed',error:'bad',retryable:false});
    assert.deepEqual(await a.job('network'),{status:'preparing'});await a.retain(3,[id]);
    const proxy=createServer(bridge(req=>proxyMedia(w.base,id,req)));await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
    const address=proxy.address();if(!address||typeof address==='string')throw Error('bad proxy address');
    try {
      const range=await fetch(`http://127.0.0.1:${address.port}/media/${id}`,{headers:{Range:'bytes=0-0','If-Range':'ok','X-Evil':'x'}});
      assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 0-0/1');assert.equal(range.headers.get('x-secret'),null);
      const head=await fetch(`http://127.0.0.1:${address.port}/media/${id}`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    } finally {proxy.close();}
  } finally {w.server.close();}
});

test('candidate search is metadata-only, limited to ten candidates; worker outage says configuration, not removed recording', async () => {
  const w=await worker((req,res)=>{
    let data='';req.on('data',(chunk:any)=>data+=chunk);req.on('end',()=>{
      assert.equal(req.url,'/api/search'); assert.equal(req.method,'POST');
      assert.equal(JSON.parse(data).query,'Artist Song');
      res.end(JSON.stringify({candidates:Array.from({length:20},()=>({url:'https://youtu.be/abcdefghijk',title:'Song',channel:'Artist',durationSec:123}))}));
    });
  });
  try {
    const adapter=new WorkerAdapter({baseUrl:w.base});
    assert.equal((await adapter.search({provider:'spotify',itemId:'A'.repeat(22),title:'Song',artists:['Artist'],durationMs:123000})).length,10);
  } finally { await new Promise<void>(r=>w.server.close(()=>r())); }
  const adapter=new WorkerAdapter({baseUrl:w.base,resolveTimeoutMs:100});
  await assert.rejects(adapter.resolve(adapter.canonicalize('https://youtu.be/abcdefghijk'),'request'),(e:any)=>e.technical && e.details.kind==='worker_unavailable' && e.message.includes('audio worker'));
});

test('positive metadata cache preserves purpose and shares equivalent catalog search text',async()=>{
  let resolves=0, searches=0;
  const w=await worker((req,res)=>{
    let raw='';req.on('data',(chunk:any)=>raw+=chunk);req.on('end',()=>{
      if(req.url==='/api/resolve') {resolves++;res.end(JSON.stringify({source:'fixture:request',title:'Request',artist:null,duration:4,recordingKey:'fixture:request'}));}
      else {searches++;res.end(JSON.stringify({candidates:[{url:'https://youtu.be/abcdefghijk',title:'Song Pt 1',channel:'Artist',durationSec:120}]}));}
    });
  });
  try {
    const a=new WorkerAdapter({baseUrl:w.base});
    const first=await a.resolve(a.canonicalize('fixture:request'),'request');first.title='Mutated';
    assert.equal((await a.resolve(a.canonicalize('fixture:request'),'request')).title,'Request');assert.equal(resolves,1);
    await a.resolve(a.canonicalize('fixture:request'),'master');assert.equal(resolves,2,'master cache cannot bypass request duration validation');
    const track={provider:'spotify' as const,itemId:'A'.repeat(22),title:'Song (Pt. 1)',artists:['Artist'],durationMs:120000};
    await a.search(track);await a.search({...track,title:'Song, Pt. 1',provider:'apple_music'});assert.equal(searches,1);
  } finally {await new Promise<void>(r=>w.server.close(()=>r()));}
});
