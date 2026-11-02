import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
async function freePort() {
  const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();assert.ok(address && typeof address!=='string');
  await new Promise<void>(r=>server.close(()=>r()));return address.port;
}
async function startup(args:string[], config:Record<string,string>={}) {
  const data=mkdtempSync(join(tmpdir(),'jukebox-runtime-')), port=await freePort();
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('JUKEBOX_')));
  const child=spawn(process.execPath,['src/server/main.ts','--port',String(port),'--data',data,...args],{env:{...env,...config},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  try {
    for(let attempt=0;attempt<100;attempt++) {
      if(output.includes('Jukebox queue service:')) return output;
      if(child.exitCode!==null) throw Error(output);
      await new Promise(r=>setTimeout(r,20));
    }
    throw Error('startup timed out');
  } finally {
    const stopped=new Promise<void>(r=>child.once('exit',()=>r()));
    if(child.exitCode===null){child.kill('SIGTERM');await stopped;}
    rmSync(data,{recursive:true,force:true});
  }
}
test('PH ID startup without --worker chooses live worker/catalog; fake media requires explicit opt-in',async()=>{
  // Dummy registration config, no live PH ID request or credential required.
  const output=await startup([], {JUKEBOX_PHID_CLIENT_ID:'fixture-client',JUKEBOX_PHID_REDIRECT_URI:'http://127.0.0.1:9999/auth/callback',JUKEBOX_SESSION_SECRET:'fixture-session-secret-'.repeat(3)});
  assert.match(output,/PH ID; audio worker http:\/\/127\.0\.0\.1:8971; live catalog matching/);
  assert.doesNotMatch(output,/fake media|FAKE local sign-in|FIXTURE MEDIA/);
  assert.match(await startup(['--dev-auth','--fixture-media']),/EXPLICIT FIXTURE MEDIA/);
  assert.match(await startup(['--dev-auth','--fixture-matching']),/EXPLICIT FIXTURE MEDIA/);
  assert.match(await startup(['--dev-auth'],{JUKEBOX_WORKER_URL:'http://127.0.0.1:9998'}),/audio worker http:\/\/127\.0\.0\.1:9998/);
});

test('run-dev leaves an outdated existing worker running and identifies the needed update',async()=>{
  const {createServer:createHttpServer}=await import('node:http');
  const old=createHttpServer((_req,res)=>res.end(JSON.stringify({limits:{jobSeconds:240}})));
  await new Promise<void>(r=>old.listen(0,'127.0.0.1',r));
  const address=old.address();assert.ok(address&&typeof address!=='string');
  const data=mkdtempSync(join(tmpdir(),'jukebox-old-worker-'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('JUKEBOX_')));
  try {
    const child=spawn('./scripts/run-dev',['--data',data],{env:{...env,JUKEBOX_SERVICE_PORT:String(await freePort()),JUKEBOX_APP_PORT:String(await freePort()),JUKEBOX_WORKER_URL:`http://127.0.0.1:${address.port}`},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
    const code=await new Promise(r=>child.once('exit',r));
    assert.equal(code,1);assert.match(output,/existing audio worker needs an update/);assert.equal(old.listening,true);
  } finally {await new Promise<void>(r=>old.close(()=>r()));rmSync(data,{recursive:true,force:true});}
});
