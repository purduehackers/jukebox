/** Dev/production supervisor: one Astro/Bun process and one private uv worker. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import net from 'node:net';
import { validateProduction } from '../src/server/production.ts';

const production = process.argv[2] === 'production';
const explicitTestAuth = process.env.JUKEBOX_DEV_AUTH === '1' || process.argv.includes('--dev-auth');
if (!production && !explicitTestAuth && existsSync('.env.local')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env.local', 'utf8')))) {
    if (key.startsWith('JUKEBOX_') && process.env[key] === undefined) process.env[key] = value;
  }
}
const { values } = parseArgs({ args: process.argv.slice(3), options: {
  data: { type: 'string' }, worker: { type: 'string' }, port: { type: 'string' },
  'dev-auth': { type: 'boolean' }, 'fixture-media': { type: 'boolean' }, 'fixture-matching': { type: 'boolean' },
} });
if (values.data) process.env.JUKEBOX_SERVICE_DATA = resolve(values.data);
if (values.worker) process.env.JUKEBOX_WORKER_URL = values.worker;
if (values['dev-auth']) process.env.JUKEBOX_DEV_AUTH = '1';
if (values['fixture-media']) process.env.JUKEBOX_FIXTURE_MEDIA = '1';
if (values['fixture-matching']) process.env.JUKEBOX_FIXTURE_MATCHING = '1';
if (production) process.env.NODE_ENV = 'production';
const fixtures = process.env.JUKEBOX_FIXTURE_MEDIA === '1' || process.env.JUKEBOX_FIXTURE_MATCHING === '1';
const port = Number(values.port ?? process.env.PORT ?? (production ? process.env.JUKEBOX_SERVICE_PORT ?? '8080' : process.env.JUKEBOX_APP_PORT ?? '5173'));
const host = process.env.HOST ?? (production ? process.env.JUKEBOX_SERVICE_HOST ?? '127.0.0.1' : '127.0.0.1');
process.env.PORT = String(port);
process.env.HOST = host;
process.env.JUKEBOX_ORIGIN ??= process.env.JUKEBOX_PHID_REDIRECT_URI ? new URL(process.env.JUKEBOX_PHID_REDIRECT_URI).origin : `http://127.0.0.1:${port}`;
const workerPort = Number(process.env.JUKEBOX_WORKER_PORT ?? '8971');
const externalWorker = !!process.env.JUKEBOX_WORKER_URL;
process.env.JUKEBOX_WORKER_URL ??= `http://127.0.0.1:${workerPort}`;
validateProduction(process.env, { data: process.env.JUKEBOX_SERVICE_DATA ?? '.local/service', devAuth: process.env.JUKEBOX_DEV_AUTH === '1', fixtures });
if (production && !process.env.JUKEBOX_WORKER_DATA?.startsWith('/')) throw Error('Set an absolute JUKEBOX_WORKER_DATA');
if (production && !existsSync('dist/server/entry.mjs')) throw Error('Run bun run build first');
if (!process.env.JUKEBOX_PHID_CLIENT_ID && process.env.JUKEBOX_DEV_AUTH !== '1') throw Error('Configure PH ID in .env.local; fake authentication requires explicit --dev-auth');
async function freePort(value: number, bind: string) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw Error('Invalid port');
  const listener = net.createServer();
  await new Promise<void>((ok, fail) => listener.once('error', fail).listen(value, bind, ok));
  await new Promise<void>(ok => listener.close(() => ok()));
}
await freePort(port, host);
const children = new Set<ChildProcess>();
const exits = new Map<ChildProcess, Promise<void>>();
let stopping = false;
function start(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env });
  children.add(child);
  exits.set(child, new Promise<void>(ok => child.once('exit', () => { children.delete(child); ok(); if (!stopping) void shutdown(1); })));
  child.once('error', error => { console.error(error); void shutdown(1); });
  return child;
}
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const deadline = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 8000);
  await Promise.all(exits.values());
  clearTimeout(deadline);
  process.exit(code);
}
process.once('SIGTERM', () => void shutdown(0));
process.once('SIGINT', () => void shutdown(0));
async function workerState() {
  try {
    const r = await fetch(process.env.JUKEBOX_WORKER_URL + '/api/status', { signal: AbortSignal.timeout(1000) });
    const b = await r.json();
    return r.ok && b.limits?.jobSeconds ? b.capabilities?.candidateSearch === 1 ? 'ready' : 'old' : 'down';
  } catch { return 'down'; }
}
try {
  if (!fixtures) {
    const state = await workerState();
    if (state === 'old') throw Error('The existing audio worker needs an update; existing worker left running');
    if (state !== 'ready') {
      if (externalWorker) throw Error('JUKEBOX_WORKER_URL is unreachable; existing worker left unchanged');
      await freePort(workerPort, '127.0.0.1');
      for (const tool of ['uv', 'ffmpeg', 'ffprobe']) if (!Bun.which(tool)) throw Error(`Missing ${tool}`);
      if (!existsSync('.venv/bin/python')) throw Error('Run uv sync --locked first');
      start('uv', ['run', '--no-sync', 'python', '-m', 'jukebox.server', '--port', String(workerPort), '--data', process.env.JUKEBOX_WORKER_DATA ?? '.local/dev-worker']);
      const deadline = Date.now() + 30000;
      while (await workerState() !== 'ready') {
        if (Date.now() > deadline) throw Error('Worker startup timed out');
        await Bun.sleep(100);
      }
    } else if (production && !externalWorker) throw Error('Worker port is already occupied; refuse to attach production to another stack');
  }
  start(process.execPath, ['--no-env-file', ...(production ? ['scripts/start-web.ts'] : ['node_modules/astro/bin/astro.mjs', 'dev', '--ignore-lock', '--host', host, '--port', String(port)])]);
} catch (error) { console.error(error); await shutdown(1); }
