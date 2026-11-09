import { bridge } from './http-server.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WorkerAdapter, proxyMedia } from '../src/adapters/worker.ts';

const python=join(process.cwd(),'.venv/bin/python');
const hasPython=spawnSync(python,['--version'],{stdio:'ignore'}).status===0;
const hasFfmpeg=spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status===0;
test('real Python worker fixture resolve → prepare → job → retain → proxy HEAD', {skip:!hasPython||!hasFfmpeg?'.venv/bin/python or ffmpeg missing; skipping real worker integration':false},async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'jukebox-worker-'));
  const child=spawn(python,['-m','jukebox.server','--port','0','--data',dir],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',(s:string)=>output+=s);
  try {
    const deadline=Date.now()+8000;while(!output.includes('proof: ')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
    assert.match(output,/proof: http:\/\/127\.0\.0\.1:\d+\/display/);
    const base=output.match(/proof: (http:\/\/127\.0\.0\.1:\d+)\/display/)![1]!;
    const adapter=new WorkerAdapter({baseUrl:base,requestTimeoutMs:10000});
    const resolved=await adapter.resolve(adapter.canonicalize('fixture:request'),'request');assert.equal(resolved.durationSec,4);
    const job=await adapter.prepare(resolved,'request');let state=await adapter.job(job.jobId);const jobDeadline=Date.now()+15000;
    while(state.status==='preparing'&&Date.now()<jobDeadline){await new Promise(r=>setTimeout(r,100));state=await adapter.job(job.jobId);}
    assert.equal(state.status,'ready');if(state.status!=='ready')return;
    await adapter.retain(1,[state.asset.assetId]);
    const proxy=createServer(bridge(req=>proxyMedia(base,state.asset.assetId,req)));await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
    const address=proxy.address();if(!address||typeof address==='string')throw Error('bad proxy address');
    try {const head=await fetch(`http://127.0.0.1:${address.port}/media/${state.asset.assetId}`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'audio/webm');}
    finally {proxy.close();}
  } finally {
    child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},1500);});
    await rm(dir,{recursive:true,force:true});
  }
});
