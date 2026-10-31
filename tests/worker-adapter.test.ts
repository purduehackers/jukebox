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
    if(req.url==='/api/resolve'&&JSON.parse(data).source==='fixture:request'){res.setHeader('content-type','application/json');res.end(JSON.stringify({source:'fixture:request',title:'request',artist:null,duration:4,recordingKey:'fixture:request'}));}
    else if(req.url==='/api/resolve'&&JSON.parse(data).source==='fixture:song'){res.statusCode=400;res.end(JSON.stringify({error:'Requests must be strictly under six minutes'}));}
    else if(req.url==='/api/resolve'){setTimeout(()=>res.end('{}'),100);}
    else {res.statusCode=404;res.end('{}');}
  });});
  try {
    const a=new WorkerAdapter({baseUrl:w.base,resolveTimeoutMs:1000});
    const ref=a.canonicalize('fixture:request'); const resolved=await a.resolve(ref,'request');
    assert.equal(resolved.durationSec,4);assert.deepEqual(resolved.selection,{source:'fixture:request'});
    await assert.rejects(()=>a.resolve(a.canonicalize('fixture:song'),'request'),(e:any)=>e.code==='DURATION_REJECTED');
    const before=requests;await assert.rejects(()=>a.resolve(a.canonicalize('https://open.spotify.com/track/1234567890123456789012'),'request'),(e:any)=>e.code==='SOURCE_UNSUPPORTED');assert.equal(requests,before);
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
    const proxy=createServer((req,res)=>proxyMedia(w.base,id,req,res));await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
    const address=proxy.address();if(!address||typeof address==='string')throw Error('bad proxy address');
    try {
      const range=await fetch(`http://127.0.0.1:${address.port}/media/${id}`,{headers:{Range:'bytes=0-0','If-Range':'ok','X-Evil':'x'}});
      assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 0-0/1');assert.equal(range.headers.get('x-secret'),null);
      const head=await fetch(`http://127.0.0.1:${address.port}/media/${id}`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    } finally {proxy.close();}
  } finally {w.server.close();}
});
