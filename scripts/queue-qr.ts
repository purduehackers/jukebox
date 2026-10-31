// Print (and optionally render) the QR for the attendee page of a TEST or real origin.
// Refuses loopback origins and, unless --no-check, confirms the service answers there first.
//   node scripts/queue-qr.ts --origin https://jukebox.purduehackers.com
//   node scripts/queue-qr.ts --origin http://192.168.1.20:5173 --png .local/queue-qr.png
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { OriginError, queueEntryUrl } from '../app/src/queue/origin.ts';

export async function checkReachable(origin: string, timeoutMs = 5000): Promise<void> {
  const health = await fetch(new URL('/healthz', origin), { signal: AbortSignal.timeout(timeoutMs) });
  if (!health.ok) throw new Error(`${origin}/healthz answered ${health.status}`);
  const page = await fetch(new URL('/queue', origin), { signal: AbortSignal.timeout(timeoutMs) });
  if (!page.ok) throw new Error(`${origin}/queue answered ${page.status}`);
}

async function main() {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, png: { type: 'string' }, 'no-check': { type: 'boolean', default: false } } });
  if (!values.origin) throw new OriginError('Pass --origin <phone-reachable origin>');
  const target = queueEntryUrl(values.origin);
  if (!values['no-check']) await checkReachable(new URL(target).origin);
  console.log(target);
  // Argument arrays only: the URL is never interpolated into a shell command.
  if (values.png) execFileSync('qrencode', ['-o', values.png, '-s', '8', '-m', '2', '-l', 'M', target]);
  else execFileSync('qrencode', ['-t', 'ANSIUTF8', '-m', '1', '-l', 'M', target], { stdio: 'inherit' });
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error instanceof OriginError ? `Refusing: ${error.message}` : `Not reachable: ${error.message}`);
    process.exit(1);
  });
}
